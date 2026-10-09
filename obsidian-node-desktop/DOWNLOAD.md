# Download Obsidian Node

Obsidian Node is the desktop app for running and operating an Obsidian Network node. This page
says where to get it, how to check what you downloaded, and how to build it yourself.

> **Status of the builds.** The desktop app lives in the `obsidian-node-desktop/` directory of the
> Obsidian-Network repository. Its installers are produced by the *Desktop app release* workflow
> ([`.github/workflows/desktop-release.yml`](../.github/workflows/desktop-release.yml)) when a tag named
> `desktop-v<version>` is pushed, and appear on the
> **[Releases page](https://github.com/EmoluxLabs/Obsidian-Network/releases)** next to the network's own `v*` releases
> (look for **Obsidian Node desktop-v…**). If there is no such release yet, no installer has been published —
> build from source (below) or run the workflow by hand.
>
> **Available now:** the pre-release
> **[desktop-v1.0.0-rc.2](https://github.com/EmoluxLabs/Obsidian-Network/releases/tag/desktop-v1.0.0-rc.2)** — built by the
> workflow on Windows, macOS and Linux runners, each package checked by `verify-package.mjs`. It is a release
> candidate: the installers were built and checked from their files, but have not yet been launched on each OS by
> a person, so treat first launches as a test and report problems.
> **The installers are not code-signed** (no certificate has been bought). Your OS will warn you the
> first time; the steps below show how to proceed safely and how to verify the file first.

## 1. Pick your file

| System | File | Notes |
|---|---|---|
| Windows 10/11 (64-bit) | `Obsidian-Node-Setup-<version>-win-x64.exe` | Installer. Per-user, no admin rights needed. |
| Windows 10/11 (64-bit) | `Obsidian-Node-Portable-<version>-win-x64.exe` | Single file, no install. Run it from any folder. |
| macOS, Apple silicon (M1 and later) | `Obsidian-Node-<version>-mac-arm64.dmg` | |
| macOS, Intel | `Obsidian-Node-<version>-mac-x64.dmg` | |
| Linux (any distribution) | `Obsidian-Node-<version>-linux-x86_64.AppImage` | No install: `chmod +x` and run. |
| Debian / Ubuntu | `Obsidian-Node-<version>-linux-amd64.deb` | `sudo apt install ./<file>.deb` |

The version in the name is the release tag without the `v`; the exact file names are listed on the Release page.

Download from the Releases page, or from a terminal with the GitHub CLI:

```bash
TAG=desktop-v1.0.0-rc.2     # the release you want; list them with: gh release list --repo EmoluxLabs/Obsidian-Network
gh release download "$TAG" --repo EmoluxLabs/Obsidian-Network --pattern '*win-x64*'      # Windows files
gh release download "$TAG" --repo EmoluxLabs/Obsidian-Network --pattern '*.AppImage'     # Linux AppImage
gh release download "$TAG" --repo EmoluxLabs/Obsidian-Network --pattern 'SHA256SUMS'     # the checksum list
```

The tag is required: this repository also publishes the network's own `v*` releases, so "the latest release" is not necessarily the desktop app.

## 2. Verify the download

Each release carries a `SHA256SUMS` file. Put it in the same folder as the installer and run:

```bash
# Linux
sha256sum --ignore-missing -c SHA256SUMS
# macOS
shasum -a 256 -c SHA256SUMS --ignore-missing
```

```powershell
# Windows PowerShell — print the hash and compare it with the line in SHA256SUMS
Get-FileHash .\Obsidian-Node-Setup-<version>-win-x64.exe -Algorithm SHA256
```

The line for your file must match exactly. If it does not, delete the file and download it again.
A checksum proves the file is the one the release published; it does not replace code signing.

## 3. Install and first launch

**Windows.** Run the installer. SmartScreen says *"Windows protected your PC"* because the file is unsigned:
choose **More info → Run anyway** (only after the checksum matched).

**macOS.** Open the `.dmg`, drag *Obsidian Node* to *Applications*. The first time, macOS may say the app
*"can't be opened"* or is *"damaged"* because it is not notarized. Right-click the app → **Open** → **Open**,
or, once, in Terminal: `xattr -dr com.apple.quarantine "/Applications/Obsidian Node.app"`.

**Linux AppImage.**

```bash
chmod +x Obsidian-Node-*.AppImage
./Obsidian-Node-*.AppImage
```

If it refuses to start with a sandbox error (some distributions restrict unprivileged user namespaces),
prefer the `.deb`, which installs the sandbox helper correctly. As a last resort only, run the AppImage
with `--no-sandbox`; that switches off Chromium's process sandbox for the window, so do it only for a build
whose checksum you verified.

**Linux .deb.** `sudo apt install ./Obsidian-Node-*.deb`, then start *Obsidian Node* from the launcher.

### What the app does on first launch

* It does **not** create a chain, a genesis or a wallet by itself, and it never wipes data without a
  confirmation. You choose the network (mainnet, testnet, staging or devnet) and start the node yourself.
* The node is the real `obsidian-core` that ships inside the app; everything the screens show comes from
  that node's RPC. Where the node has no answer yet the app says "unavailable" rather than showing a number.
* Your data lives in the OS user-data folder for *Obsidian Node* (Windows `%APPDATA%\Obsidian Node`,
  macOS `~/Library/Application Support/Obsidian Node`, Linux `~/.config/Obsidian Node`). **Uninstalling does
  not delete it.** Back up the wallet vault and your recovery phrase; nobody can recover them for you.

## 4. Build it yourself

You need Node 20.10 or newer (22 recommended). The app is built from the core in the same repository.

```bash
git clone https://github.com/EmoluxLabs/Obsidian-Network.git
cd Obsidian-Network
(cd obsidian-core && npm ci && npm run build)

cd obsidian-node-desktop
npm ci
npm run stage:core        # copies the built core into vendor/
npm start                 # run from source
npm run dist              # installers for the OS you are on → release/
```

An installer can only be built for the OS it is built on (Windows → `.exe`, macOS → `.dmg`, Linux →
`.AppImage`/`.deb`), which is why the workflow builds on all three.

## 5. Publishing a release (maintainers)

```bash
git tag desktop-v1.0.0
git push origin desktop-v1.0.0
```

The *Desktop app release* workflow runs the checks, builds the three platforms, runs
[`scripts/verify-package.mjs`](scripts/verify-package.mjs) on each package (the real core and its
dependencies are inside; tests and the browser bridge are not), writes `SHA256SUMS` and publishes the
Release. **Run workflow** from the Actions tab builds the same files as downloadable workflow artifacts
without publishing a release.

## 6. Other ways to deliver the download

| Option | What it is | Fits when | Cost / catch |
|---|---|---|---|
| **GitHub Releases** (what the workflow does) | One page, direct file links, built-in checksum list via `SHA256SUMS` | Default; free for public repos | Per-version file names; links are `…/releases/download/<tag>/<file>` |
| **A download button on the website** | Small page that asks the GitHub API (`/repos/EmoluxLabs/Obsidian-Network/releases`, picking the newest `desktop-v*` tag), detects the visitor's OS and links the right asset | You want "Download for Windows" on the Obsidian site | A few lines of JavaScript; no extra hosting. Can be hosted on the existing Cloudflare Pages site |
| **Cloudflare R2 + a custom domain** | Copy the release files to a bucket and serve `downloads.<your-domain>/obsidian-node-latest-win-x64.exe` with stable names | You want branded, stable URLs and no GitHub dependency | R2 has no egress fees; needs a bucket and one workflow step to upload; you own the uptime |
| **Auto-update (electron-updater)** | The app checks the Releases feed and updates itself | After you have a real signing certificate | Unsigned builds cannot update safely on macOS and Windows; not enabled here on purpose |
| **Package managers** | `winget`, Homebrew cask, a Linux apt repo / Flatpak | Once releases are stable and signed | Each needs a manifest and review; later work |
| **Code signing** | Windows Authenticode (or Azure Trusted Signing), Apple Developer ID + notarization | Before wide public distribution | The only way to remove the SmartScreen/Gatekeeper warnings; needs paid certificates, which cannot be committed |

The fastest path to a public download is the first row: push a `desktop-v*` tag. The next best is the second row,
which only adds a button on top of the same files.
