package network.obsidian.mobile.ui.screens

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import network.obsidian.mobile.identity.ProfileStore
import network.obsidian.mobile.identity.WatchProfile
import network.obsidian.mobile.remote.Addresses
import network.obsidian.mobile.remote.ChainLink
import network.obsidian.mobile.remote.ObsidianRepository
import network.obsidian.mobile.ui.ChainValues
import network.obsidian.mobile.ui.components.GoldKicker
import network.obsidian.mobile.ui.components.MenuRow
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
 * Identity in Obsidian is a key, not an account.
 *
 * These four screens are built on that fact rather than around it. There is no
 * account server, no account database and no invitation system in the protocol,
 * so nothing here authenticates against one and nothing here pretends to. What
 * the device genuinely holds is a watch profile: a label and a bech32 address,
 * both public, plus an optional local device lock.
 *
 * Where the supplied artboards imply a centralised account — a username, a
 * password, a recovery email, an invitation code — the screen keeps the visual
 * language and states what is actually true instead of inventing the machinery.
 * A pretty screen backed by a fictional server would be a worse outcome than an
 * honest one.
 */

/** Shared explanation shown wherever a server-backed feature would be expected. */
@Composable
private fun NonCustodialNote(body: String) {
    ObsidianCard {
        GoldKicker("Non-custodial")
        Spacer(Modifier.height(ObsidianSpace.S))
        Text(body, style = ObsidianType.Support, color = ObsidianColors.Muted)
    }
}

/**
 * SIGN UP — create the device's Obsidian identity.
 *
 * Validates a real bech32 address with the protocol's own checksum before saving
 * anything, so an address the node would reject is caught here rather than at
 * send time. There is no invitation field: the protocol has no invitation system,
 * and a field that validated against nothing would be a lie with a border radius.
 */
@Composable
fun SignUpScreen(store: ProfileStore, onDone: () -> Unit, onBack: () -> Unit, onSignIn: () -> Unit) {
    var label by remember { mutableStateOf("") }
    var address by remember { mutableStateOf("") }
    var pin by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var saved by remember { mutableStateOf(false) }

    ScreenShell(title = "Create identity", kicker = "This device", onBack = onBack) {
        if (saved) {
            ObsidianCard {
                GoldKicker("Identity created")
                Spacer(Modifier.height(ObsidianSpace.S))
                Text(
                    "This device can now follow that address: its balance, its nonce and its " +
                        "chain state, all read directly from a node.",
                    style = ObsidianType.Body,
                    color = ObsidianColors.Text,
                )
                Spacer(Modifier.height(ObsidianSpace.M))
                ObsidianRow("Address", Addresses.shorten(address), mono = true, divider = false)
            }
            Spacer(Modifier.height(ObsidianSpace.M))
            PrimaryButton(label = "CONTINUE", showArrow = false, onClick = onDone)
            return@ScreenShell
        }

        NonCustodialNote(
            "Obsidian has no account server, so there is nothing to register with and no password " +
                "to forget. Your identity is your key, and your key never leaves the device that " +
                "holds it. What you create here is a watch profile: a label for an address this " +
                "device will follow.",
        )

        Spacer(Modifier.height(ObsidianSpace.M))
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
            Spacer(Modifier.height(ObsidianSpace.M))
            ObsidianTextField(
                value = pin,
                onValueChange = { pin = it.filter(Char::isDigit).take(6) },
                label = "Device lock (optional)",
                placeholder = "6 digits",
                keyboardType = androidx.compose.ui.text.input.KeyboardType.NumberPassword,
                visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(),
            )
            Spacer(Modifier.height(ObsidianSpace.XS))
            Text(
                "A local lock for this device only. It is not a second factor issued by a server, " +
                    "because no server exists to issue one.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
            Spacer(Modifier.height(ObsidianSpace.M))
            PrimaryButton(
                label = "CREATE IDENTITY",
                showArrow = false,
                onClick = {
                    error = when {
                        pin.isNotEmpty() && pin.length < ProfileStore.PIN_LENGTH ->
                            "Use ${ProfileStore.PIN_LENGTH} digits, or leave the lock empty"
                        else -> null
                    }
                    if (error == null) {
                        when (val result = store.save(
                            WatchProfile(
                                label = label,
                                address = address,
                                pinHash = null,
                                createdAtEpochMillis = System.currentTimeMillis(),
                            ),
                        )) {
                            is ProfileStore.SaveResult.Saved -> {
                                if (pin.isNotEmpty()) store.setPin(result.profile.address, pin)
                                saved = true
                            }
                            is ProfileStore.SaveResult.Rejected -> error = result.reason
                        }
                    }
                },
            )
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        SecondaryButton(label = "I ALREADY HAVE AN IDENTITY", showArrow = false, onClick = onSignIn)
        Spacer(Modifier.height(ObsidianSpace.XL))
    }
}

/**
 * SIGN IN — unlock an identity that already exists on this device.
 *
 * There is no username and no password to check against a server. What is checked
 * is the local device lock, if the profile has one, and the check is real: the
 * PIN is compared against a salted digest, not against the digits.
 */
@Composable
fun SignInScreen(store: ProfileStore, onUnlock: (WatchProfile) -> Unit, onBack: () -> Unit, onSignUp: () -> Unit) {
    val profiles = remember { store.all() }
    var selected by remember { mutableStateOf(profiles.firstOrNull()?.address) }
    var pin by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }

    ScreenShell(title = "Unlock", kicker = "This device", onBack = onBack) {
        if (profiles.isEmpty()) {
            NonCustodialNote(
                "No identity has been created on this device yet. Because Obsidian is " +
                    "non-custodial, nothing can be fetched for you from a server — an identity " +
                    "starts here, from an address you control.",
            )
            Spacer(Modifier.height(ObsidianSpace.M))
            PrimaryButton(label = "CREATE IDENTITY", showArrow = false, onClick = onSignUp)
            Spacer(Modifier.height(ObsidianSpace.XL))
            return@ScreenShell
        }

        SectionLabel("IDENTITIES ON THIS DEVICE")
        Spacer(Modifier.height(ObsidianSpace.XS))
        ObsidianCard {
            profiles.forEachIndexed { index, profile ->
                MenuRow(
                    title = profile.label,
                    subtitle = Addresses.shorten(profile.address),
                    value = if (selected == profile.address) "Selected" else null,
                    valueColor = ObsidianColors.GoldText,
                    onClick = { selected = profile.address; error = null },
                    divider = index != profiles.lastIndex,
                )
            }
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        ObsidianCard {
            val needsPin = profiles.firstOrNull { it.address == selected }?.pinHash != null
            if (needsPin) {
                ObsidianTextField(
                    value = pin,
                    onValueChange = { pin = it.filter(Char::isDigit).take(6); error = null },
                    label = "Device lock",
                    keyboardType = androidx.compose.ui.text.input.KeyboardType.NumberPassword,
                    visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(),
                    error = error,
                )
                Spacer(Modifier.height(ObsidianSpace.M))
            } else {
                Text(
                    "This profile has no device lock. Add one from the Account screen.",
                    style = ObsidianType.Support,
                    color = ObsidianColors.Muted,
                )
                Spacer(Modifier.height(ObsidianSpace.S))
            }
            PrimaryButton(
                label = "UNLOCK",
                showArrow = false,
                onClick = {
                    val profile = profiles.firstOrNull { it.address == selected }
                    if (profile == null) {
                        error = "Choose an identity"
                    } else if (profile.pinHash == null) {
                        onUnlock(profile)
                    } else if (store.checkPin(profile.address, pin)) {
                        onUnlock(profile)
                    } else {
                        error = "That lock does not match"
                        pin = ""
                    }
                },
            )
        }

        Spacer(Modifier.height(ObsidianSpace.XL))
    }
}

/**
 * TWO-FACTOR — a device lock over a non-custodial identity.
 *
 * This screen is deliberately not a one-time-code form. An OTP field validating
 * against a hardcoded code would be fake two-factor authentication, and labelling
 * a local check "2FA enabled" would claim a second factor that no second party
 * ever issued. What is real here is a lock on this device, checked against a
 * salted digest, protecting access to a profile on it.
 */
@Composable
fun TwoFactorScreen(store: ProfileStore, onBack: () -> Unit) {
    val profiles = remember { store.all() }
    var pin by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }
    var isError by remember { mutableStateOf(false) }
    val target = profiles.firstOrNull()

    ScreenShell(title = "Device lock", kicker = "Security", onBack = onBack) {
        NonCustodialNote(
            "This is a lock on this device, not two-factor authentication. Obsidian has no account " +
                "server, so there is no second factor for one to issue and no code that could be " +
                "sent to you. What the lock does is real: it keeps the profiles on this phone " +
                "behind a code that is stored only as a salted digest.",
        )

        Spacer(Modifier.height(ObsidianSpace.M))
        if (target == null) {
            ObsidianCard {
                Text(
                    "No identity exists on this device to lock. Create one first.",
                    style = ObsidianType.Support,
                    color = ObsidianColors.Muted,
                )
            }
        } else {
            ObsidianCard {
                ObsidianRow("Profile", target.label, divider = false)
                Spacer(Modifier.height(ObsidianSpace.M))
                ObsidianTextField(
                    value = pin,
                    onValueChange = { pin = it.filter(Char::isDigit).take(6); message = null },
                    label = if (target.pinHash == null) "New lock" else "Replace lock",
                    keyboardType = androidx.compose.ui.text.input.KeyboardType.NumberPassword,
                    visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(),
                )
                Spacer(Modifier.height(ObsidianSpace.M))
                ObsidianTextField(
                    value = confirm,
                    onValueChange = { confirm = it.filter(Char::isDigit).take(6); message = null },
                    label = "Confirm lock",
                    keyboardType = androidx.compose.ui.text.input.KeyboardType.NumberPassword,
                    visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(),
                )
                Spacer(Modifier.height(ObsidianSpace.M))
                PrimaryButton(
                    label = if (target.pinHash == null) "SET DEVICE LOCK" else "UPDATE DEVICE LOCK",
                    showArrow = false,
                    onClick = {
                        when {
                            pin.length < ProfileStore.PIN_LENGTH -> {
                                isError = true
                                message = "Use ${ProfileStore.PIN_LENGTH} digits"
                            }
                            pin != confirm -> {
                                isError = true
                                message = "The two entries do not match"
                            }
                            else -> {
                                val reason = store.setPin(target.address, pin)
                                isError = reason != null
                                message = reason ?: "Device lock set for ${target.label}"
                                pin = ""
                                confirm = ""
                            }
                        }
                    },
                )
                if (message != null) {
                    Spacer(Modifier.height(ObsidianSpace.S))
                    Text(
                        message!!,
                        style = ObsidianType.Support,
                        color = if (isError) ObsidianColors.Danger else ObsidianColors.SuccessText,
                    )
                }
            }
        }
        Spacer(Modifier.height(ObsidianSpace.XL))
    }
}

/**
 * ACCOUNT RECOVERY — what recovery means when nobody holds your key.
 *
 * There is no support desk and no server-side reset, so this screen does not
 * promise one. It states what actually restores access, and offers the one
 * recovery this device can perform: re-attaching to an address.
 */
@Composable
fun AccountRecoveryScreen(store: ProfileStore, onBack: () -> Unit, onRecoverWallet: () -> Unit) {
    ScreenShell(title = "Recovery", kicker = "Security", onBack = onBack) {
        NonCustodialNote(
            "Obsidian is non-custodial: no server holds your key, so no server can reset it and no " +
                "support channel can restore it. Recovery is cryptographic, not administrative. If " +
                "the key material is gone, the funds are not recoverable by anyone — that is the " +
                "property that makes the chain trustworthy, and it applies here too.",
        )

        Spacer(Modifier.height(ObsidianSpace.M))
        SectionLabel("WHAT ACTUALLY RESTORES ACCESS")
        Spacer(Modifier.height(ObsidianSpace.XS))
        ObsidianCard {
            MenuRow(
                title = "Restore the key",
                subtitle = "Using the wallet tooling that created it",
                onClick = onRecoverWallet,
            )
            MenuRow(
                title = "Re-attach this device",
                subtitle = "Watch an address you already control",
                onClick = onRecoverWallet,
                divider = false,
            )
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        ObsidianCard {
            GoldKicker("About the device lock")
            Spacer(Modifier.height(ObsidianSpace.S))
            Text(
                "The lock on this device protects the profiles stored here. It is not a recovery " +
                    "mechanism and clearing it does not recover a key — removing a profile from " +
                    "this phone changes nothing on the chain, because the chain never knew the " +
                    "phone existed.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
            Spacer(Modifier.height(ObsidianSpace.M))
            val profiles = remember { store.all() }
            if (profiles.isEmpty()) {
                Text("No profiles are stored on this device.", style = ObsidianType.Support, color = ObsidianColors.Muted)
            } else {
                profiles.forEachIndexed { index, profile ->
                    ObsidianRow(
                        label = profile.label,
                        value = Addresses.shorten(profile.address),
                        mono = true,
                        divider = index != profiles.lastIndex,
                    )
                }
            }
        }
        Spacer(Modifier.height(ObsidianSpace.XL))
    }
}

/**
 * ACCOUNT — the real state of this device's identity.
 *
 * Every value comes from the chain or from the device: the address, its live
 * balance and nonce from a node, the network the node reports, and the Edge
 * Node's actual state. Nothing here is a server-side account record, because
 * there is no such thing in this protocol.
 */
@Composable
fun AccountScreen(
    store: ProfileStore,
    repository: ObsidianRepository,
    onBack: () -> Unit,
    onWallet: () -> Unit,
    onSecurity: () -> Unit,
    onEdgeNode: () -> Unit,
    onSignIn: () -> Unit,
) {
    val link by repository.link.collectAsState()
    val edgeEnabled by network.obsidian.mobile.edgenode.EdgeNodeTelemetry.enabled.collectAsState()
    val profile = remember { store.active() }

    ScreenShell(title = "Account", kicker = "Identity", onBack = onBack) {
        if (profile == null) {
            NonCustodialNote(
                "No identity is active on this device. Unlock an existing one, or create a profile " +
                    "for an address you control.",
            )
            Spacer(Modifier.height(ObsidianSpace.M))
            PrimaryButton(label = "UNLOCK IDENTITY", showArrow = false, onClick = onSignIn)
            Spacer(Modifier.height(ObsidianSpace.XL))
            return@ScreenShell
        }

        ObsidianCard {
            SectionLabel("IDENTITY")
            Spacer(Modifier.height(ObsidianSpace.S))
            Text(profile.label, style = ObsidianType.Statement, color = ObsidianColors.Ink)
            Spacer(Modifier.height(ObsidianSpace.XS))
            Text(profile.address, style = ObsidianType.Mono, color = ObsidianColors.Muted)
            Spacer(Modifier.height(ObsidianSpace.S))
            ObsidianRow("Custody", "Non-custodial", divider = false)
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        SectionLabel("ON CHAIN")
        Spacer(Modifier.height(ObsidianSpace.XS))
        ObsidianCard {
            val online = link as? ChainLink.Online
            val degraded = link as? ChainLink.Degraded
            when {
                online != null -> ObsidianRow("Block height", ChainValues.count(online.health.height), mono = true)
                degraded != null -> ObsidianRow("Block height", ChainValues.count(degraded.last.health.height), mono = true)
                else -> ObsidianRow("Block height", "—", mono = true)
            }
            ObsidianRow(
                label = "Link",
                value = when (link) {
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
            ObsidianRow("Edge Node", if (edgeEnabled) "Enabled" else "Disabled", divider = false)
            Spacer(Modifier.height(ObsidianSpace.S))
            Text(
                "Balance and transactions for this address are on the Wallet screen, read from the " +
                    "node on demand rather than cached here.",
                style = ObsidianType.Support,
                color = ObsidianColors.Muted,
            )
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        SectionLabel("SECURITY")
        Spacer(Modifier.height(ObsidianSpace.XS))
        ObsidianCard {
            MenuRow("Device lock", subtitle = "Protects profiles on this phone", onClick = onSecurity)
            MenuRow("Wallet", subtitle = "Balance, address and relay", onClick = onWallet)
            MenuRow("Edge Node", subtitle = "Verify and relay only", onClick = onEdgeNode, divider = false)
        }

        Spacer(Modifier.height(ObsidianSpace.M))
        SecondaryButton(
            label = "SWITCH IDENTITY",
            showArrow = false,
            onClick = onSignIn,
        )
        Spacer(Modifier.height(ObsidianSpace.XL))
    }
}
