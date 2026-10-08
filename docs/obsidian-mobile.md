# Obsidian Mobile — native Android client

Status: **work in progress.** The project builds, lints and produces an installable
APK in CI. One screen is implemented. This document records what is verified, what
is not, and how to reproduce both.

---

## 1. What this is

A native Android application written in Kotlin with Jetpack Compose. It is not a
WebView, not a browser shortcut and not a PWA shell — there is no bundled web
asset, no `WebView` reference in the source, and the screens are Compose
composables drawing against a design-token set derived from the supplied UI/UX
artboards.

It embeds an **Obsidian Edge Node**: a foreground service that connects to a node,
verifies the data it is given and relays it. See §6.

- Source: `obsidian-mobile/`
- Application ID: `network.obsidian.mobile` (debug builds carry the `.debug` suffix)
- `minSdk` 26 (Android 8.0), `targetSdk` / `compileSdk` 34 (Android 14)
- Build system: Gradle 8.7, AGP 8.5.2, Kotlin 2.0.20, Compose BOM 2024.09.03

---

## 2. Building it

There is no wrapper JAR committed, because one cannot be produced in the
environment where this was written. Run this once from `obsidian-mobile/` to
create it, then commit `gradlew`, `gradlew.bat` and `gradle/wrapper/`:

```
gradle wrapper --gradle-version 8.7
```

After that:

```
./gradlew assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease      # app/build/outputs/apk/release/app-release-unsigned.apk
./gradlew testDebugUnitTest    # unit tests
./gradlew lintDebug            # lint
```

CI does exactly this on every push touching `obsidian-mobile/**`, via
`.github/workflows/android.yml`, and uploads the result as the `OBSIDIAN-apk`
artefact. Tagging `android-v*` publishes a GitHub Release.

---

## 3. Verified build output

From workflow run **37800067872** (branch `arena/414b663a-obsidian-network`,
commit `889c592`). Every value below is taken from the built package via `aapt2`
and `apksigner`, printed back as check-run annotations — not from the manifest or
from the build script's intent.

| Fact | Value |
| --- | --- |
| Artefact | `app-debug.apk`, 18,836,732 bytes |
| SHA-256 | `4ee5211f26dea58db7ee4c55a208f216465397316503aa8764f09853703ab38a` |
| Package | `network.obsidian.mobile.debug` |
| versionCode / versionName | `1` / `1.0.0` |
| minSdk / targetSdk | `26` / `34` |
| Launchable activity | `network.obsidian.mobile.MainActivity` |
| Debug signing | signed, `CN=Android Debug` (SHA-256 `6ca474e9…a04512`) |
| Release variant | **UNSIGNED** — `apksigner` exit 1 |
| CI steps | unit tests ✓, lint ✓, assembleDebug ✓, assembleRelease ✓ |

The release APK is unsigned because no keystore was supplied. That is deliberate
and it is reported in the run rather than left to assumption. Set
`OBSIDIAN_KEYSTORE`, `OBSIDIAN_KEYSTORE_PASSWORD`, `OBSIDIAN_KEY_ALIAS` and
`OBSIDIAN_KEY_PASSWORD` as repository secrets to produce a signed release. **Do
not** install the unsigned release APK on a device; use the debug build, which is
signed with the standard Android debug key.

---

## 4. Permissions

Exactly five, confirmed by `aapt2 dump badging` on the built APK:

| Permission | Why |
| --- | --- |
| `INTERNET` | Talk to an Obsidian node's RPC and to Obsidian peers |
| `ACCESS_NETWORK_STATE` | Pause the Edge Node when offline instead of polling blindly |
| `FOREGROUND_SERVICE` | Run the Edge Node as a user-visible foreground service |
| `FOREGROUND_SERVICE_DATA_SYNC` | Required type declaration for that service on Android 14 |
| `POST_NOTIFICATIONS` | Show the foreground-service notification on Android 13+ |

Deliberately **not** requested:

- `RECEIVE_BOOT_COMPLETED` — the Edge Node must never restart itself behind the
  user's back. There is no boot receiver anywhere in the project.
- `WAKE_LOCK` — a phone is not a server. The service pauses when the OS suspends
  it instead of holding the CPU awake.
- Location, contacts, storage, camera, SMS, microphone — nothing here needs them.

---

## 5. Data layer

`remote/ObsidianApi.kt` is a typed client for the existing node API. It consumes
19 existing REST endpoints plus `/rpc`:

`/health` `/status` `/supply` `/params` `/network` `/peers` `/nodes` `/validators`
`/finality` `/mempool` `/mining/schedule` `/revenue` `/genesis` `/version`
`/wallet/balance` `/tx/encode` `/tx/gas` `/tx/simulate` `/tx/submit` and `POST /rpc`.

**No new endpoint was added to the node and no existing response shape was
changed.** The client is read-mostly by construction; the only mutating calls it
exposes are the ones the existing API already defines.

`remote/ObsidianRepository.kt` owns a single poller for the whole app rather than
one per screen, and models the link to the chain as `Offline | Online | Degraded`
so every screen can render the correct state instead of guessing.

### Values that are deliberately absent

`/supply` returns `totalSupplyObs`, `maxSupplyObs`, `genesisIssuedObs`,
`minedSupplyObs`, `validatorBonds` and `poolBalanceObs`. It does **not** return a
circulating-supply figure, so the app does not display one and
`ui/ChainValues.kt` does not derive one. Where a template artboard shows a
circulating-supply number, that number is a placeholder and is not reproduced.

---

## 6. Edge Node architecture

`edgenode/EdgeNodeService.kt`. The role is **verify and relay** — connectivity,
nothing else.

What it does:

- Runs as a foreground service with a visible notification the user can act on.
- Connects to a configured node, reads the head that node reports, and checks
  that head is internally consistent before treating it as progress. A node
  answering with an inconsistent head is reported as invalid data, not relayed.
- Publishes its state as a `StateFlow` the UI reads, so what the device is doing
  is never hidden from the user.
- Returns `START_NOT_STICKY`. If the OS kills it, it stays dead until the user
  opens the app again.
- Pauses on connectivity loss and resumes when permitted, without fighting the
  OS for background execution it has not been granted.

What it structurally cannot do — these are absences in the code, not assertions
in a comment:

- There is no signing, key-loading or block-construction code in the package.
- There is no reference to the wallet keystore, a seed phrase or any private key.
  The Edge Node runs in a separate security domain from the wallet and starts with
  no secret material.
- There is no wake lock, and no `BootReceiver` anywhere in the project, so it
  cannot restart itself after the user stops it and does not persist after being
  disabled.

**Voting power and rewards are zero, and not because the service declines them.**
Voting weight in this protocol comes from a 20,000 OBS bond recorded in chain
state. The Edge Node holds no key that could register one, so it has no vote to
cast and nothing to earn. Ten thousand Edge Nodes add propagation, not authority:
one node and ten thousand confer identical consensus standing, which is the
anti-Sybil property required. An Edge Node is not a Node Runner and is never
included in Node Runner payout calculations.

---

## 7. What is not done yet

Stated plainly, because a green CI run is not a finished app:

- **Screens.** `Routes` in `MainActivity.kt` declares 16 routes; exactly one
  composable is registered, so 15 routes are declared but render nothing when
  navigated to. Implemented: Landing (artboard 01). Declared only: Menu, Sign Up,
  Sign In, Two-Factor Verification, Account Recovery, Create Wallet, Recover
  Wallet, Account, Mining, Active Mining, Wallet, Explorer, ONS, Edge Node,
  Settings. The supplied design set covers 18 artboards, so a few screens still
  need routes as well as composables.
- **The Edge Node has no UI.** The service exists and is declared in the manifest,
  but no screen can start, stop or inspect it. Its security tests (A–H) cannot be
  run until that screen exists.
- **No unit tests yet.** `testDebugUnitTest` passes because the module compiles and
  the task runs; it asserts nothing. There is no coverage of `ChainValues.kt`, the
  repository's state transitions or the Edge Node's head-consistency check, all of
  which are pure enough to test without a device.
- **Never installed on a device or emulator.** Nothing in this sandbox can run an
  Android emulator, and Actions' artefact storage is not reachable from it either,
  so the APK has been inspected with `aapt2`/`apksigner` but not launched. Screen
  rendering, touch targets, keyboard behaviour and rotation are unverified.
- **No download button on the web interface.** A real artefact now exists, but it
  lives on a branch's CI artefact page rather than at a stable, published URL.
  Pointing a button at that would be pointing at something that expires, so the
  button waits for a published release.

---

## 8. Design fidelity

`ui/theme/ObsidianTokens.kt` encodes the values read out of the supplied
artboards' inline `style` attributes: the `#F6F7F9` canvas, `#0B0D10` ink,
`#C8A85A` gold, the 28/20/14/16 radii, the three shadow recipes, and the Manrope /
JetBrains Mono type scale. Screens draw from those tokens rather than restating
colours, so the design system stays the single source of truth and a screen added
later inherits it instead of inventing its own.

Where an artboard does not cover a state — offline, error, empty, retry — the
state is built from the same tokens in `ui/components/States.kt`. Nothing is
restyled to Material defaults and no screen is redesigned to accommodate a field.
