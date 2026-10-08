package network.obsidian.mobile.ui.screens

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import network.obsidian.mobile.R
import network.obsidian.mobile.edgenode.EdgeNodeService
import network.obsidian.mobile.edgenode.EdgeNodeState
import network.obsidian.mobile.edgenode.EdgeNodeTelemetry
import network.obsidian.mobile.identity.ProfileStore
import network.obsidian.mobile.identity.WatchProfile
import network.obsidian.mobile.remote.Addresses
import network.obsidian.mobile.remote.BalanceResponse
import network.obsidian.mobile.remote.ChainLink
import network.obsidian.mobile.remote.ObsidianRepository
import network.obsidian.mobile.ui.ChainValues
import network.obsidian.mobile.ui.components.EmptyBlock
import network.obsidian.mobile.ui.components.ErrorBlock
import network.obsidian.mobile.ui.components.GoldKicker
import network.obsidian.mobile.ui.components.InlineStateBlock
import network.obsidian.mobile.ui.components.LoadingBlock
import network.obsidian.mobile.ui.components.MenuRow
import network.obsidian.mobile.ui.components.ObsidianCard
import network.obsidian.mobile.ui.components.ObsidianDarkCard
import network.obsidian.mobile.ui.components.ObsidianRow
import network.obsidian.mobile.ui.components.ObsidianTextField
import network.obsidian.mobile.ui.components.PrimaryButton
import network.obsidian.mobile.ui.components.SecondaryButton
import network.obsidian.mobile.ui.components.SectionLabel
import network.obsidian.mobile.ui.components.StatusDot
import network.obsidian.mobile.ui.theme.ObsidianColors
import network.obsidian.mobile.ui.theme.ObsidianRadius
import network.obsidian.mobile.ui.theme.ObsidianSpace
import network.obsidian.mobile.ui.theme.ObsidianType

/*
 * The twelve screens the blueprint defines, in its order and with its names:
 * splash, landing, signup, signin, home, mine, wallet, explorer, ons, node, api,
 * menu.
 *
 * The blueprint is a demo and labels itself as one. Its layout is followed; its
 * data is not. Specifically these five behaviours are deliberately absent, because
 * each is a fabrication the reference file itself flags:
 *
 *   - VALID=['OBS-FOUN-D001',…] — a hardcoded invite list. The referral field is
 *     rendered because the design has it, but no code is ever reported as
 *     verified: the protocol has no invitation system to verify against.
 *   - "DEMO: password is not verified" — sign-in unlocks a local device profile
 *     and says so. It does not claim an account was authenticated.
 *   - claim(){ S.bal += RATE*4 } — rewards invented into a local balance.
 *   - SESS=14400 — a four-hour mining session the protocol does not have.
 *   - TAKEN/FEE/PRICE — invented ONS availability, fee and price.
 *
 * Everything numeric comes from a node, or is marked unavailable.
 */

/** The blueprint's logo helper, at the sizes it uses. */
@Composable
fun BrandMark(size: Int, modifier: Modifier = Modifier) {
    Image(
        painter = painterResource(R.drawable.obsidian_logo),
        contentDescription = "Obsidian",
        modifier = modifier.size(size.dp),
        contentScale = ContentScale.Fit,
    )
}

/** The blueprint's `hdr(title)`: brand row plus an uppercase title. */
@Composable
fun BlueprintHeader(title: String, onMenu: (() -> Unit)? = null) {
    Row(
        Modifier.fillMaxWidth().height(ObsidianMetricsHeader).padding(horizontal = ObsidianSpace.Gutter),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            BrandMark(38)
            Spacer(Modifier.width(ObsidianSpace.S))
            Text("OBSIDIAN NETWORK", style = ObsidianType.Wordmark, color = ObsidianColors.Ink)
        }
        if (onMenu != null) {
            Box(
                Modifier.size(44.dp).background(ObsidianColors.Surface, RoundedCornerShape(12.dp)),
                contentAlignment = Alignment.Center,
            ) {
                androidx.compose.material3.TextButton(onClick = onMenu) {
                    Text("MENU", style = ObsidianType.Kicker, color = ObsidianColors.GoldText)
                }
            }
        }
    }
    Text(title, style = ObsidianType.Hero, color = ObsidianColors.Ink, modifier = Modifier.padding(horizontal = ObsidianSpace.Gutter))
    Spacer(Modifier.height(ObsidianSpace.M))
}

private val ObsidianMetricsHeader = 76.dp

/** Page frame: canvas, gutters, scroll — the blueprint's #app container. */
@Composable
fun BlueprintPage(
    title: String,
    onMenu: (() -> Unit)? = null,
    header: Boolean = true,
    content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit,
) {
    Column(
        Modifier.fillMaxSize().background(ObsidianColors.Canvas)
            .statusBarsPadding().verticalScroll(rememberScrollState())
            .padding(horizontal = ObsidianSpace.Gutter, vertical = ObsidianSpace.L),
    ) {
        if (header) BlueprintHeader(title, onMenu)
        content()
        Spacer(Modifier.height(100.dp))
    }
}

/** The status pill the blueprint repeats: NETWORK LIVE / Operational / Active. */
@Composable
fun StatusPill(label: String, value: String, colour: androidx.compose.ui.graphics.Color) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        StatusDot(colour)
        Spacer(Modifier.width(ObsidianSpace.XS))
        SectionLabel(label)
        Spacer(Modifier.width(ObsidianSpace.XS))
        Text(value, style = ObsidianType.Value, color = colour)
    }
}

// ── 2. LANDING ───────────────────────────────────────────────────────────────

@Composable
fun LandingScreen(
    repository: ObsidianRepository,
    onNavigate: (String) -> Unit,
) {
    val link by repository.link.collectAsState()
    val online = link as? ChainLink.Online
    val degraded = (link as? ChainLink.Degraded)?.last

    BlueprintPage(title = "The Proof of Time Blockchain", onMenu = { onNavigate(R_MENU) }) {
        GoldKicker("Invite-only · Proof of Time")
        Spacer(Modifier.height(ObsidianSpace.S))
        Text(
            "Obsidian is a blockchain built around time, participation and transparent " +
                "verification. Hold your own wallet, follow the chain, and inspect every block.",
            style = ObsidianType.Body,
            color = ObsidianColors.Text,
        )
        Spacer(Modifier.height(ObsidianSpace.XL))
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { BrandMark(190) }
        Spacer(Modifier.height(ObsidianSpace.XL))

        PrimaryButton("START MINING", onClick = { onNavigate(R_MINE) }, showArrow = false)
        Spacer(Modifier.height(ObsidianSpace.S))
        SecondaryButton("CREATE WALLET", onClick = { onNavigate(R_SIGNUP) }, showArrow = false)
        Spacer(Modifier.height(ObsidianSpace.S))
        SecondaryButton("EXPLORER", onClick = { onNavigate(R_EXPLORER) }, showArrow = false)

        Spacer(Modifier.height(ObsidianSpace.XL))
        ObsidianCard {
            StatusPill(
                label = "Network",
                value = when (link) {
                    is ChainLink.Online -> if (online!!.health.syncing) "Syncing" else "Live"
                    is ChainLink.Degraded -> "Connection lost"
                    ChainLink.Offline -> "Not connected"
                },
                colour = when (link) {
                    is ChainLink.Online -> ObsidianColors.SuccessText
                    is ChainLink.Degraded -> ObsidianColors.Danger
                    ChainLink.Offline -> ObsidianColors.Muted
                },
            )
            Spacer(Modifier.height(ObsidianSpace.S))
            ObsidianRow("Consensus", "Proof of Time")
            ObsidianRow(
                label = "Block height",
                value = ChainValues.count(online?.health?.height ?: degraded?.health?.height),
                mono = true,
            )
            ObsidianRow(
                label = "Network status",
                value = when (link) {
                    is ChainLink.Online -> "Operational"
                    is ChainLink.Degraded -> "Degraded"
                    ChainLink.Offline -> "Unavailable"
                },
                divider = false,
            )
            if (link is ChainLink.Offline) {
                Spacer(Modifier.height(ObsidianSpace.S))
                Text(
                    "No node has answered. Obsidian nodes are self-hosted — set the address in " +
                        "Settings. No figure above is estimated.",
                    style = ObsidianType.Support,
                    color = ObsidianColors.Muted,
                )
            }
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        ObsidianCard {
            SectionLabel("Built for participation")
            Spacer(Modifier.height(ObsidianSpace.S))
            MenuRow("Obsidian Name Service", onClick = { onNavigate(R_ONS) })
            MenuRow("Edge Node", onClick = { onNavigate(R_NODE) })
            MenuRow("Developer API", onClick = { onNavigate(R_API) })
            MenuRow("Sign up / Sign in", onClick = { onNavigate(R_SIGNUP) }, divider = false)
        }

        Spacer(Modifier.height(ObsidianSpace.XL))
        ObsidianDarkCard {
            Text("OBSIDIAN NETWORK", style = ObsidianType.Wordmark, color = ObsidianColors.Surface)
            Spacer(Modifier.height(6.dp))
            Text("Build. Validate. Decentralize.", style = ObsidianType.Support, color = ObsidianColors.OnDarkMuted)
        }
    }
}

// ── 3 & 4. SIGN UP / SIGN IN ─────────────────────────────────────────────────

@Composable
fun SignUpScreen(store: ProfileStore, onSignIn: () -> Unit, onDone: () -> Unit) {
    var email by remember { mutableStateOf("") }
    var label by remember { mutableStateOf("Main wallet") }
    var address by remember { mutableStateOf("") }
    var referral by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var done by remember { mutableStateOf(false) }

    BlueprintPage(title = "Create your account", header = true) {
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { BrandMark(76) }
        Spacer(Modifier.height(ObsidianSpace.M))
        Text("OBSIDIAN NETWORK", style = ObsidianType.Wordmark, color = ObsidianColors.Ink, modifier = Modifier.fillMaxWidth(), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        Spacer(Modifier.height(ObsidianSpace.L))

        if (done) {
            ObsidianCard {
                SectionLabel("Profile created")
                Spacer(Modifier.height(ObsidianSpace.S))
                ObsidianRow("Address", Addresses.shorten(address), mono = true, divider = false)
            }
            Spacer(Modifier.height(ObsidianSpace.M))
            PrimaryButton("CONTINUE", onClick = onDone, showArrow = false)
            return@BlueprintPage
        }

        ObsidianCard {
            // The design shows a referral code because the reference is invite-only.
            // The protocol has no invitation system, so the field is collected and
            // format-checked, and the app says plainly that it cannot verify one.
            // Claiming "code verified" would be a fabricated authorisation.
            Text(
                "Obsidian is non-custodial: there is no account server, so this creates a " +
                    "profile on this device for an address you control. It does not register " +
                    "you with anyone.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
            Spacer(Modifier.height(ObsidianSpace.M))
            ObsidianTextField(email, { email = it; error = null }, "Email (optional, stays on device)", "you@example.com")
            Spacer(Modifier.height(ObsidianSpace.M))
            ObsidianTextField(label, { label = it; error = null }, "Profile label", "Main wallet")
            Spacer(Modifier.height(ObsidianSpace.M))
            ObsidianTextField(address, { address = it; error = null }, "Obsidian address", "obs1…", error = error)
            Spacer(Modifier.height(ObsidianSpace.M))
            ObsidianTextField(
                referral,
                { referral = it.uppercase(); error = null },
                "Referral code (optional)",
                "OBS-XXXX-XXXX",
            )
            Spacer(Modifier.height(ObsidianSpace.XS))
            Text(
                "Format is checked only. Obsidian publishes no invitation service, so this app " +
                    "cannot and does not verify a code — entering one changes nothing on chain.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
            Spacer(Modifier.height(ObsidianSpace.M))
            PrimaryButton(
                "CREATE ACCOUNT",
                showArrow = false,
                onClick = {
                    error = if (referral.isNotBlank() && !Regex("^OBS-[A-Z0-9]{4}-[A-Z0-9]{4}$").matches(referral)) {
                        "A referral code looks like OBS-XXXX-XXXX"
                    } else null
                    if (error == null) {
                        when (val r = store.save(WatchProfile(label, address, null, System.currentTimeMillis()))) {
                            is ProfileStore.SaveResult.Saved -> done = true
                            is ProfileStore.SaveResult.Rejected -> error = r.reason
                        }
                    }
                },
            )
        }
        Spacer(Modifier.height(ObsidianSpace.M))
        SecondaryButton("ALREADY HAVE AN ACCOUNT? SIGN IN", onClick = onSignIn, showArrow = false)
    }
}

@Composable
fun SignInScreen(store: ProfileStore, onUnlock: () -> Unit, onSignUp: () -> Unit) {
    val profiles = remember { store.all() }
    var pin by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    val target = profiles.firstOrNull()

    BlueprintPage(title = "Welcome back") {
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { BrandMark(96) }
        Spacer(Modifier.height(ObsidianSpace.M))
        Text("OBSIDIAN NETWORK", style = ObsidianType.Wordmark, color = ObsidianColors.Ink, modifier = Modifier.fillMaxWidth(), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        Spacer(Modifier.height(ObsidianSpace.L))

        if (target == null) {
            ObsidianCard {
                Text(
                    "No profile exists on this device. Because Obsidian has no account server, " +
                        "there is nothing to sign into — an identity starts here, from an address " +
                        "you control.",
                    style = ObsidianType.Support,
                    color = ObsidianColors.Muted,
                )
            }
            Spacer(Modifier.height(ObsidianSpace.M))
            PrimaryButton("CREATE ACCOUNT", onClick = onSignUp, showArrow = false)
            return@BlueprintPage
        }

        ObsidianCard {
            ObsidianRow("Profile", target.label)
            ObsidianRow("Address", Addresses.shorten(target.address), mono = true, divider = false)
            Spacer(Modifier.height(ObsidianSpace.M))
            if (target.pinHash != null) {
                ObsidianTextField(
                    pin, { pin = it.filter(Char::isDigit).take(6); error = null },
                    "Device lock",
                    keyboardType = androidx.compose.ui.text.input.KeyboardType.NumberPassword,
                    visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(),
                    error = error,
                )
                Spacer(Modifier.height(ObsidianSpace.M))
            } else {
                Text(
                    "This profile has no device lock. The check below unlocks this device only — " +
                        "it is not server authentication, because no server holds an account.",
                    style = ObsidianType.Support,
                    color = ObsidianColors.Muted,
                )
                Spacer(Modifier.height(ObsidianSpace.M))
            }
            PrimaryButton(
                "SIGN IN",
                showArrow = false,
                onClick = {
                    if (target.pinHash == null) onUnlock()
                    else if (store.checkPin(target.address, pin)) onUnlock()
                    else { error = "That lock does not match"; pin = "" }
                },
            )
        }
        Spacer(Modifier.height(ObsidianSpace.M))
        SecondaryButton("NEW TO OBSIDIAN? CREATE ACCOUNT", onClick = onSignUp, showArrow = false)
    }
}

// ── 5. HOME ──────────────────────────────────────────────────────────────────

@Composable
fun HomeScreen(store: ProfileStore, repository: ObsidianRepository, onNavigate: (String) -> Unit) {
    val link by repository.link.collectAsState()
    val scope = rememberCoroutineScope()
    val profile = remember { store.active() }
    var balance by remember { mutableStateOf<BalanceResponse?>(null) }
    var loading by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }

    BlueprintPage(title = "Welcome back.", onMenu = { onNavigate(R_MENU) }) {
        ObsidianCard {
            SectionLabel("OBS balance")
            Spacer(Modifier.height(ObsidianSpace.S))
            when {
                profile == null -> Text("No address attached.", style = ObsidianType.Support, color = ObsidianColors.Muted)
                loading -> LoadingBlock(label = "Reading balance")
                failed -> InlineStateBlock(
                    title = "Balance unavailable",
                    body = "The node did not answer for this address.",
                    onRetry = { failed = false; loading = true; scope.launch { readBalance(repository, profile.address) { balance = it; loading = false; failed = it == null } } },
                )
                else -> {
                    Text("${ChainValues.obs(balance?.balanceObs)} OBS", style = ObsidianType.MonoLarge, color = ObsidianColors.Ink)
                    Spacer(Modifier.height(ObsidianSpace.XS))
                    ObsidianRow("Nonce", (balance?.nonce ?: 0).toString(), mono = true, divider = false)
                }
            }
            Spacer(Modifier.height(ObsidianSpace.S))
            SecondaryButton(
                "REFRESH", showArrow = false,
                onClick = {
                    loading = true; failed = false
                    scope.launch { readBalance(repository, profile?.address.orEmpty()) { balance = it; loading = false; failed = it == null } }
                },
            )
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        ObsidianCard {
            SectionLabel("Mining status")
            Spacer(Modifier.height(ObsidianSpace.S))
            val online = link as? ChainLink.Online
            ObsidianRow("This device", "Not mining", valueColor = ObsidianColors.Muted)
            ObsidianRow("Active miners", online?.status?.activeMiners?.toString() ?: "—", mono = true)
            ObsidianRow("Mining claims", ChainValues.count(online?.status?.metrics?.miningClaims), mono = true, divider = false)
            Spacer(Modifier.height(ObsidianSpace.S))
            Text(
                "This device runs no miner. Claiming is a signed transaction and the app holds " +
                    "no key.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        ObsidianCard {
            SectionLabel("Network status")
            Spacer(Modifier.height(ObsidianSpace.S))
            val o = (link as? ChainLink.Online) ?: (link as? ChainLink.Degraded)?.last
            ObsidianRow("Status", if (link is ChainLink.Offline) "Unavailable" else "Operational")
            ObsidianRow("Block height", ChainValues.count(o?.health?.height), mono = true)
            ObsidianRow("Peers", o?.health?.peers?.toString() ?: "—", mono = true, divider = false)
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        ObsidianCard {
            SectionLabel("Recent activity")
            Spacer(Modifier.height(ObsidianSpace.S))
            EmptyBlock(
                title = "No activity feed",
                body = "The node exposes transactions by id, not a per-address history, so none " +
                    "is listed here rather than showing an invented one. Look one up in the " +
                    "Explorer.",
            )
            Spacer(Modifier.height(ObsidianSpace.S))
            MenuRow("Wallet", onClick = { onNavigate(R_WALLET) })
            MenuRow("Explorer", onClick = { onNavigate(R_EXPLORER) })
            MenuRow("Mining", onClick = { onNavigate(R_MINE) }, divider = false)
        }
    }
}

private suspend fun readBalance(
    repository: ObsidianRepository,
    address: String,
    onResult: (BalanceResponse?) -> Unit,
) {
    if (address.isBlank()) { onResult(null); return }
    onResult(repository.api.balance(address).getOrNull())
}

// ── 6. MINE ──────────────────────────────────────────────────────────────────

@Composable
fun MineScreen(store: ProfileStore, repository: ObsidianRepository, onNavigate: (String) -> Unit) {
    val link by repository.link.collectAsState()
    val online = link as? ChainLink.Online
    val supply = online?.supply

    BlueprintPage(title = "Mining", onMenu = { onNavigate(R_MENU) }) {
        ObsidianCard {
            SectionLabel("OBS supply")
            Spacer(Modifier.height(ObsidianSpace.S))
            if (supply == null) {
                EmptyBlock(
                    title = "Supply unavailable",
                    body = "The node did not answer /supply. Nothing is estimated in its place.",
                )
            } else {
                // The blueprint's arc showed a mining session. The protocol has no
                // session, so the ring shows a real ratio instead: minted against
                // the maximum the protocol defines.
                Text(
                    "${ChainValues.mintedSupply(supply)} / ${ChainValues.maximumSupply(supply)} OBS",
                    style = ObsidianType.MonoValue,
                    color = ObsidianColors.Ink,
                )
                Spacer(Modifier.height(ObsidianSpace.S))
                ObsidianRow("Mined", ChainValues.minedSupply(supply), mono = true)
                ObsidianRow("Remaining to mint", ChainValues.remainingToMint(supply), mono = true)
                ObsidianRow("Reward pool", ChainValues.poolBalance(supply), mono = true, divider = false)
            }
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        ObsidianCard {
            SectionLabel("This device")
            Spacer(Modifier.height(ObsidianSpace.S))
            Text("Not mining", style = ObsidianType.Statement, color = ObsidianColors.Ink)
            Spacer(Modifier.height(ObsidianSpace.XS))
            Text(
                "Obsidian Mobile runs no miner and is not a validator. Producing a block needs a " +
                    "registered bond and a signing key; this app has neither and does not " +
                    "simulate having them. The blueprint's four-hour session and hourly rate are " +
                    "demo values with no counterpart in the protocol, so they are not shown.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
            Spacer(Modifier.height(ObsidianSpace.M))
            ObsidianRow("Address", profile(store)?.let { Addresses.shorten(it) } ?: "None attached", mono = true)
            ObsidianRow("Block height", ChainValues.count(online?.health?.height), mono = true)
            ObsidianRow("Active miners", online?.status?.activeMiners?.toString() ?: "—", mono = true)
            ObsidianRow("Settled claims", ChainValues.count(online?.status?.pool?.settledClaims), mono = true, divider = false)
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        ObsidianCard {
            GoldKicker("Proof of Time")
            Spacer(Modifier.height(ObsidianSpace.S))
            Text(
                "Validators are scheduled into slots and produce blocks in turn; mining claims " +
                    "are how rewards reach miners. Those rules live in the protocol and are " +
                    "neither restated nor altered here.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
        }
    }
}

private fun profile(store: ProfileStore): String? = store.active()?.address

// ── 7. WALLET ────────────────────────────────────────────────────────────────

@Composable
fun WalletScreen(store: ProfileStore, repository: ObsidianRepository, onNavigate: (String) -> Unit) {
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    val profile = remember { store.active() }
    var receive by remember { mutableStateOf(true) }
    var balance by remember { mutableStateOf<BalanceResponse?>(null) }
    var txId by remember { mutableStateOf("") }
    var txOut by remember { mutableStateOf<String?>(null) }
    var txErr by remember { mutableStateOf<String?>(null) }

    BlueprintPage(title = "Wallet", onMenu = { onNavigate(R_MENU) }) {
        ObsidianCard {
            SectionLabel("OBS balance")
            Spacer(Modifier.height(ObsidianSpace.S))
            if (profile == null) {
                EmptyBlock(title = "No wallet attached", body = "Create a profile for an address you control.")
                Spacer(Modifier.height(ObsidianSpace.S))
                SecondaryButton("CREATE ACCOUNT", showArrow = false, onClick = { onNavigate(R_SIGNUP) })
                return@ObsidianCard
            }
            Text("${ChainValues.obs(balance?.balanceObs)} OBS", style = ObsidianType.MonoLarge, color = ObsidianColors.Ink)
            Spacer(Modifier.height(ObsidianSpace.S))
            ObsidianRow("Nonce", (balance?.nonce ?: 0).toString(), mono = true)
            ObsidianRow("Bonded", ChainValues.obs(balance?.bondedObs), mono = true, divider = false)
            Spacer(Modifier.height(ObsidianSpace.S))
            SecondaryButton(
                "REFRESH", showArrow = false,
                onClick = { scope.launch { readBalance(repository, profile.address) { balance = it } } },
            )
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(ObsidianSpace.S)) {
            Box(Modifier.weight(1f)) { SecondaryButton("RECEIVE", showArrow = false, onClick = { receive = true }) }
            Box(Modifier.weight(1f)) { SecondaryButton("SEND", showArrow = false, onClick = { receive = false }) }
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        ObsidianCard {
            if (receive && profile != null) {
                SectionLabel("Your Obsidian address")
                Spacer(Modifier.height(ObsidianSpace.S))
                Text(profile.address, style = ObsidianType.Mono, color = ObsidianColors.Text)
                Spacer(Modifier.height(ObsidianSpace.M))
                PrimaryButton("COPY ADDRESS", showArrow = false, onClick = { clipboard.setText(AnnotatedString(profile.address)) })
            } else {
                GoldKicker("Watch only")
                Spacer(Modifier.height(ObsidianSpace.S))
                Text(
                    "This wallet holds no private key, so it cannot sign and will not pretend to. " +
                    "Signing belongs to the existing Obsidian wallet tooling, which is the " +
                    "protocol's own cryptographic authority. A send form here that reported " +
                    "success would be a fabricated transaction.",
                    style = ObsidianType.Support,
                    color = ObsidianColors.Muted,
                )
                Spacer(Modifier.height(ObsidianSpace.M))
                SectionLabel("Transaction lookup")
                Spacer(Modifier.height(ObsidianSpace.XS))
                ObsidianTextField(txId, { txId = it; txOut = null; txErr = null }, "Transaction id", "tx hash")
                Spacer(Modifier.height(ObsidianSpace.S))
                PrimaryButton(
                    "LOOK UP", showArrow = false, enabled = txId.isNotBlank(),
                    onClick = {
                        scope.launch {
                            repository.api.transaction(txId.trim()).fold(
                                onSuccess = { if (it == null) txErr = "The node has no transaction with that id." else txOut = it.toString() },
                                onFailure = { txErr = it.message ?: "The node could not be reached." },
                            )
                        }
                    },
                )
                if (txErr != null) { Spacer(Modifier.height(ObsidianSpace.S)); ErrorBlock(title = "Not found", body = txErr!!) }
                if (txOut != null) { Spacer(Modifier.height(ObsidianSpace.S)); Text(txOut!!, style = ObsidianType.Mono, color = ObsidianColors.Text) }
            }
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        ObsidianCard {
            SectionLabel("Recent transactions")
            Spacer(Modifier.height(ObsidianSpace.S))
            EmptyBlock(
                title = "No transactions listed",
                body = "The node has no per-address history endpoint, so none is shown. Inventing " +
                    "a list here would be worse than an empty one.",
            )
        }
    }
}

// ── 8. EXPLORER ──────────────────────────────────────────────────────────────

@Composable
fun ExplorerScreen(repository: ObsidianRepository, onNavigate: (String) -> Unit) {
    val link by repository.link.collectAsState()
    val scope = rememberCoroutineScope()
    var q by remember { mutableStateOf("") }
    var outTitle by remember { mutableStateOf<String?>(null) }
    var outBody by remember { mutableStateOf<String?>(null) }
    var blocks by remember { mutableStateOf<List<String>?>(null) }
    val online = link as? ChainLink.Online
    val height = online?.health?.height ?: (link as? ChainLink.Degraded)?.last?.health?.height

    androidx.compose.runtime.LaunchedEffect(height) {
        val h = height ?: return@LaunchedEffect
        blocks = repository.api.blocks(from = (h - 9).coerceAtLeast(0), limit = 10).getOrNull()
    }

    BlueprintPage(title = "Explorer", onMenu = { onNavigate(R_MENU) }) {
        ObsidianCard {
            SectionLabel("Search")
            Spacer(Modifier.height(ObsidianSpace.XS))
            ObsidianTextField(q, { q = it; outTitle = null; outBody = null }, "Height, tx id or address", "1284906 · tx… · obs1…")
            Spacer(Modifier.height(ObsidianSpace.S))
            PrimaryButton(
                "SEARCH", showArrow = false, enabled = q.isNotBlank(),
                onClick = {
                    scope.launch {
                        val api = repository.api
                        val term = q.trim()
                        when {
                            Addresses.isValid(term) -> api.rpcBalance(term).fold(
                                { outTitle = "Address"; outBody = it?.toString() ?: "No account state for that address." },
                                { outBody = it.message },
                            )
                            term.toLongOrNull() != null -> api.block(term.toLong()).fold(
                                { outTitle = "Block $term"; outBody = it?.toString() ?: "No block at that height." },
                                { outBody = it.message },
                            )
                            else -> api.transaction(term).fold(
                                { outTitle = "Transaction"; outBody = it?.toString() ?: "No transaction with that id." },
                                { outBody = it.message },
                            )
                        }
                    }
                },
            )
            if (outTitle != null || outBody != null) {
                Spacer(Modifier.height(ObsidianSpace.S))
                if (outTitle != null) SectionLabel(outTitle!!)
                Text(outBody ?: "—", style = ObsidianType.Mono, color = ObsidianColors.Text)
            }
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        ObsidianCard {
            ObsidianRow("Block height", ChainValues.count(online?.health?.height), mono = true)
            ObsidianRow("Consensus", "Proof of Time")
            ObsidianRow("Network", online?.health?.network?.ifBlank { "—" } ?: "—")
            ObsidianRow("Chain id", (online?.health?.chainId ?: 0).toString(), mono = true, divider = false)
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        ObsidianCard {
            SectionLabel("Supply")
            Spacer(Modifier.height(ObsidianSpace.S))
            val s = online?.supply
            if (s == null) {
                EmptyBlock(title = "Supply unavailable", body = "The node did not answer /supply.")
            } else {
                ObsidianRow("Maximum", ChainValues.maximumSupply(s), mono = true)
                ObsidianRow("Total minted", ChainValues.mintedSupply(s), mono = true)
                ObsidianRow("Mined", ChainValues.minedSupply(s), mono = true)
                ObsidianRow("Remaining to mint", ChainValues.remainingToMint(s), mono = true, divider = false)
                Spacer(Modifier.height(ObsidianSpace.XS))
                Text(
                    "The protocol defines minted, mined, bonded and pooled — not circulating " +
                        "supply, so no circulating figure is displayed.",
                    style = ObsidianType.Support,
                    color = ObsidianColors.Muted,
                )
            }
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        ObsidianCard {
            SectionLabel("Latest blocks")
            Spacer(Modifier.height(ObsidianSpace.S))
            when {
                blocks == null -> LoadingBlock(label = "Reading blocks")
                blocks!!.isEmpty() -> EmptyBlock(title = "No blocks in range")
                else -> blocks!!.forEachIndexed { i, h ->
                    MenuRow("Block ${((height ?: 0) - i)}", subtitle = ChainValues.shorten(h), onClick = { }, divider = i != blocks!!.lastIndex)
                }
            }
        }
    }
}

// ── 9. ONS ───────────────────────────────────────────────────────────────────

@Composable
fun OnsScreen(repository: ObsidianRepository, onNavigate: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    var names by remember { mutableStateOf<List<String>?>(null) }
    var err by remember { mutableStateOf<String?>(null) }
    var q by remember { mutableStateOf("") }
    var result by remember { mutableStateOf<String?>(null) }

    androidx.compose.runtime.LaunchedEffect(Unit) {
        repository.api.names().fold({ names = it; err = null }, { err = it.message ?: "Names could not be read" })
    }

    BlueprintPage(title = "Obsidian Name Service", onMenu = { onNavigate(R_MENU) }) {
        ObsidianCard {
            Text("Claim a unique name tied to a wallet.", style = ObsidianType.Support, color = ObsidianColors.Muted)
            Spacer(Modifier.height(ObsidianSpace.M))
            ObsidianTextField(q, { q = it; result = null }, "Name", "name.obs")
            Spacer(Modifier.height(ObsidianSpace.S))
            PrimaryButton(
                "SEARCH", showArrow = false, enabled = q.isNotBlank(),
                onClick = {
                    scope.launch {
                        repository.api.names().fold(
                            { all ->
                                val n = q.trim().lowercase().let { if (it.endsWith(".obs")) it else "$it.obs" }
                                result = if (all.any { it == n }) "$n is registered on this chain." else "$n is not registered."
                            },
                            { result = it.message ?: "Names could not be read" },
                        )
                    }
                },
            )
            if (result != null) { Spacer(Modifier.height(ObsidianSpace.S)); Text(result!!, style = ObsidianType.Support, color = ObsidianColors.Text) }
            Spacer(Modifier.height(ObsidianSpace.S))
            Text(
                "Availability comes from the node's own name set. The reference file's TAKEN list " +
                    "is demo data and is not used.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        ObsidianCard {
            SectionLabel("Registered names")
            Spacer(Modifier.height(ObsidianSpace.S))
            when {
                err != null -> ErrorBlock(title = "Names unavailable", body = err!!)
                names == null -> LoadingBlock(label = "Reading names")
                names!!.isEmpty() -> EmptyBlock(title = "No names registered", body = "That is the chain's real state, not a placeholder.")
                else -> {
                    ObsidianRow("Total", names!!.size.toString(), mono = true, divider = false)
                    Spacer(Modifier.height(ObsidianSpace.S))
                    names!!.take(50).forEachIndexed { i, n -> MenuRow(n, onClick = { result = "$n is registered." }, divider = i != names!!.lastIndex) }
                }
            }
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        ObsidianCard {
            GoldKicker("Registration")
            Spacer(Modifier.height(ObsidianSpace.S))
            Text(
                "Registering a name is a signed transaction and this app holds no key. Its " +
                    "economics are the protocol's; nothing is restated or changed here.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
        }
    }
}

// ── 10. NODE / EDGE NODE ─────────────────────────────────────────────────────

@Composable
fun NodeScreen(repository: ObsidianRepository, onNavigate: (String) -> Unit) {
    val link by repository.link.collectAsState()
    val state by EdgeNodeState.observable.collectAsState()
    val enabled by EdgeNodeTelemetry.enabled.collectAsState()
    val verified by EdgeNodeTelemetry.blocksVerified.collectAsState()
    val rejected by EdgeNodeTelemetry.headsRejected.collectAsState()
    val last by EdgeNodeTelemetry.lastActivityAt.collectAsState()
    val context = androidx.compose.ui.platform.LocalContext.current
    val nodeUrl by repository.nodeUrl.collectAsState()
    val online = link as? ChainLink.Online

    BlueprintPage(title = "Obsidian Edge Node", onMenu = { onNavigate(R_MENU) }) {
        ObsidianCard {
            StatusPill(
                label = "Edge Node",
                value = if (enabled) "Enabled" else "Disabled",
                colour = if (enabled) ObsidianColors.SuccessText else ObsidianColors.Muted,
            )
            Spacer(Modifier.height(ObsidianSpace.S))
            Text(state.describe("Edge Node"), style = ObsidianType.Body, color = ObsidianColors.Text)
            Spacer(Modifier.height(ObsidianSpace.M))
            if (enabled) {
                SecondaryButton("STOP EDGE NODE", showArrow = false, onClick = {
                    EdgeNodeService.stop(context); EdgeNodeTelemetry.enabled.value = false
                    EdgeNodeTelemetry.reset(); EdgeNodeState.current.value = EdgeNodeState.Stopped
                })
            } else {
                PrimaryButton("START EDGE NODE", showArrow = false, onClick = { EdgeNodeService.start(context, nodeUrl) })
            }
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        ObsidianCard {
            ObsidianRow("Network", online?.health?.network?.ifBlank { "—" } ?: "—")
            ObsidianRow("Chain id", (online?.health?.chainId ?: 0).toString(), mono = true)
            ObsidianRow("Block height", ChainValues.count(online?.health?.height), mono = true)
            ObsidianRow("Peers", (online?.health?.peers ?: 0).toString(), mono = true)
            ObsidianRow("Heads verified", verified.toString(), mono = true)
            ObsidianRow("Heads rejected", rejected.toString(), mono = true)
            ObsidianRow(
                label = "Last activity",
                value = if (last == 0L) "None yet" else java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.getDefault()).format(java.util.Date(last)),
                divider = false,
            )
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        ObsidianCard {
            SectionLabel("What it never does")
            Spacer(Modifier.height(ObsidianSpace.S))
            Text(
                "The Edge Node verifies and relays. It is not a validator: it casts no vote, " +
                    "produces and finalizes no block, earns nothing for running, and holds no " +
                    "wallet key or signing authority. Ten thousand of them hold the authority one " +
                    "does — none.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
        }
    }
}

// ── 11. API ──────────────────────────────────────────────────────────────────

@Composable
fun ApiScreen(repository: ObsidianRepository, onNavigate: (String) -> Unit) {
    val link by repository.link.collectAsState()
    val nodeUrl by repository.nodeUrl.collectAsState()
    val online = link as? ChainLink.Online

    BlueprintPage(title = "Obsidian Developer", onMenu = { onNavigate(R_MENU) }) {
        ObsidianCard {
            SectionLabel("Quick start")
            Spacer(Modifier.height(ObsidianSpace.S))
            Text(
                "curl $nodeUrl/health\n\n{\n  \"network\": \"${online?.health?.network ?: "—"}\",\n" +
                    "  \"protocolVersion\": \"${online?.health?.protocolVersion ?: "—"}\",\n" +
                    "  \"height\": ${online?.health?.height ?: "—"}\n}",
                style = ObsidianType.Mono,
                color = ObsidianColors.Text,
            )
            Spacer(Modifier.height(ObsidianSpace.S))
            Text(
                "Values above are this device's live reading from the configured node, or an " +
                    "em dash when it has not answered. The reference file's api.example host is " +
                    "placeholder and is not used.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        ObsidianCard {
            SectionLabel("Endpoints this app uses")
            Spacer(Modifier.height(ObsidianSpace.S))
            listOf(
                "GET /health — status, height, head, peers, versions",
                "GET /status — chain status, metrics, mining, pool",
                "GET /supply — minted, maximum, mined, bonded, pooled",
                "POST /wallet/balance — balance and nonce for an address",
                "POST /rpc getblocks — canonical block hashes",
                "POST /rpc getblock — one header by height",
                "POST /rpc gettransaction — one indexed transaction",
                "POST /rpc getnames — registered ONS names",
            ).forEachIndexed { i, e -> ObsidianRow(e.substringBefore(" —"), e.substringAfter(" — "), divider = i != 7) }
            Spacer(Modifier.height(ObsidianSpace.S))
            Text(
                "All are existing node routes. None was added or changed for this app, and no " +
                    "response shape was altered.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
        }
    }
}

// ── 12. MENU ─────────────────────────────────────────────────────────────────

@Composable
fun MenuScreen(store: ProfileStore, repository: ObsidianRepository, onNavigate: (String) -> Unit) {
    val link by repository.link.collectAsState()
    val profile = remember { store.active() }

    BlueprintPage(title = "Menu") {
        ObsidianCard {
            MenuRow("Home", onClick = { onNavigate(R_HOME) })
            MenuRow("Mining", onClick = { onNavigate(R_MINE) })
            MenuRow("Wallet", onClick = { onNavigate(R_WALLET) })
            MenuRow("Explorer", onClick = { onNavigate(R_EXPLORER) })
            MenuRow("Obsidian Name Service", onClick = { onNavigate(R_ONS) })
            MenuRow("Edge Node", onClick = { onNavigate(R_NODE) })
            MenuRow("Developer API", onClick = { onNavigate(R_API) })
            MenuRow("Settings", onClick = { onNavigate(R_SETTINGS) }, divider = false)
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        ObsidianCard {
            SectionLabel("Account")
            Spacer(Modifier.height(ObsidianSpace.S))
            ObsidianRow("Profile", profile?.label ?: "None", divider = false)
            Spacer(Modifier.height(ObsidianSpace.S))
            SecondaryButton(
                if (profile == null) "SIGN IN" else "SWITCH PROFILE",
                showArrow = false,
                onClick = { onNavigate(R_SIGNIN) },
            )
            Spacer(Modifier.height(ObsidianSpace.XS))
            Text(
                "There is no session to sign out of: Obsidian has no account server, so this " +
                    "switches the local profile rather than ending a login.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        ObsidianCard {
            ObsidianRow("Block height", ChainValues.count((link as? ChainLink.Online)?.health?.height), mono = true)
            ObsidianRow("Link", if (link is ChainLink.Offline) "Not connected" else "Connected", divider = false)
        }
    }
}

// ── SETTINGS (network + app, required for a usable app) ──────────────────────

@Composable
fun SettingsScreen(repository: ObsidianRepository, onNavigate: (String) -> Unit) {
    var url by remember { mutableStateOf(repository.nodeUrl.value) }
    var note by remember { mutableStateOf<String?>(null) }
    val link by repository.link.collectAsState()

    BlueprintPage(title = "Settings", onMenu = { onNavigate(R_MENU) }) {
        ObsidianCard {
            ObsidianTextField(url, { url = it; note = null }, "Node address", ObsidianRepository.DEFAULT_NODE_URL)
            Spacer(Modifier.height(ObsidianSpace.S))
            PrimaryButton(
                "USE THIS NODE", showArrow = false,
                onClick = {
                    val t = url.trim()
                    if (!t.startsWith("http://") && !t.startsWith("https://")) note = "Enter a full address starting http:// or https://"
                    else { repository.setNodeUrl(t); note = "Now reading from $t" }
                },
            )
            if (note != null) { Spacer(Modifier.height(ObsidianSpace.S)); Text(note!!, style = ObsidianType.Support, color = ObsidianColors.SuccessText) }
            Spacer(Modifier.height(ObsidianSpace.S))
            Text(
                "Changing the node discards cached state, so a height on screen always belongs to " +
                    "the node actually connected.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        ObsidianCard {
            SectionLabel("About")
            Spacer(Modifier.height(ObsidianSpace.S))
            ObsidianRow("Application", "Obsidian Mobile")
            ObsidianRow("Protocol", (link as? ChainLink.Online)?.health?.protocolVersion?.ifBlank { "—" } ?: "—", mono = true)
            ObsidianRow("Custody", "Non-custodial")
            ObsidianRow("Refresh", "${ObsidianRepository.DEFAULT_POLL_MILLIS / 1000}s", mono = true, divider = false)
        }
    }
}

// Route names, exactly as the blueprint's V keys.
const val R_SPLASH = "splash"
const val R_LANDING = "landing"
const val R_SIGNUP = "signup"
const val R_SIGNIN = "signin"
const val R_HOME = "home"
const val R_MINE = "mine"
const val R_WALLET = "wallet"
const val R_EXPLORER = "explorer"
const val R_ONS = "ons"
const val R_NODE = "node"
const val R_API = "api"
const val R_MENU = "menu"
const val R_SETTINGS = "settings"
