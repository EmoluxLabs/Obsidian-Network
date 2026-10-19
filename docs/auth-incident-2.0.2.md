# Sign-in refused after registration (mainnet 2.0.2): investigation, patch, deployment and rollback

This document answers one report: an account was registered on the main site and the Genesis Invitation was redeemed, the
account store is valid and holds exactly one account with a password hash, and yet signing in at the app domain answered
HTTP 401 "invalid credentials".

**Read this first.** The repository's registration-to-sign-in path was exercised end to end, in process and as real
compiled processes (the platform plus the app's own proxy), including a restart. It behaves correctly. **No defect in
hashing, password normalisation, Gmail canonicalisation, account persistence, MFA, sessions or lockout was found that makes a
correct credential fail.** The root cause of the production 401 is therefore **not established from the code**, and the
production host was not reachable from where the investigation ran, so nothing was inspected, changed, restarted or deployed
there. What follows is what was proven, what was hardened because it was demonstrably wrong, a read-only tool that tells the
possible causes apart on the real host, and a reviewed deployment and rollback plan that has **not been run**.

## 1. What was verified in the repository

| Question | Result | Evidence |
| --- | --- | --- |
| Registration and sign-in hash identically (NFKC, no trim, no case change) | Yes | `hashSecret`, `hashSecretAsync` and both verifiers apply `normalize('NFKC')` and nothing else; known-answer vectors computed with plain Node `scrypt`, not by the code under test, verify |
| Stored format | `scrypt$32768$8$1$<16-byte salt hex>$<32-byte key hex>`, `maxmem` 256 MiB | read from the code, asserted by a test on both implementations |
| Sync and async verifiers interchangeable | Yes | cross-verification test |
| Constant-time comparison | Yes (`timingSafeEqual` over equal-length buffers) | code |
| Registration and sign-in canonicalise the address with the same function | Yes (`canonicalGmail`, both handlers and recovery) | tests: dots, `+tags`, `googlemail.com`, case, whitespace |
| Account is on disk before registration answers | Yes (`createAccount` writes durably, then the invitation write, then the answer) | test reads the file immediately after the response |
| Account survives a restart unchanged | Yes | in-process restart test, and a real compiled platform stopped with SIGTERM and started again: same account, correct password reaches the MFA decision, wrong one is refused |
| Correct password with MFA enabled | HTTP **401** with `code: ERR_MFA_REQUIRED` | test, and the real processes through the app proxy |
| Wrong password, unknown account, malformed address | HTTP 401 with one identical body `ERR_CREDENTIALS_INVALID` | test |
| Invalid and replayed TOTP code | `ERR_MFA_INVALID`; a step used by enrolment or by a sign-in cannot be reused | test |
| Suspension, lockout | Suspended: 403 with the right password, 401 with a wrong one. Ten failures lock one client out of one account (kept in memory, so a restart clears it); the account's own failure counter is stored with the account, counts wrong passwords and wrong codes from every client, resets on a successful sign-in, and locks the account for 15 minutes (a 429) when it reaches 100 | test |
| Cookie | `HttpOnly; SameSite=Lax; Path=/; Max-Age=1209600`, plus `Secure` exactly when `OBSIDIAN_INTERFACE_TRUST_PROXY=true` | test |
| Main site and app front behave the same | Yes: the app front's proxy forwards the body untouched, drops `Origin`, and passes `Set-Cookie` through; sign-in is judged identically with and without `Origin` | tests, and the existing live account scenario run through the real proxy |
| App front handles each error code | Yes: `ERR_MFA_REQUIRED` asks for a code; every other code shows the platform's own words | test drives the page's real SIGN IN handler |
| The text "Incorrect credentials; check your email or password" | **Does not exist anywhere in this repository** | `git grep`. The platform's text is "those credentials are not valid" |

The last row matters: whatever displayed that sentence was not this source tree's frontend, or it is a paraphrase. Get the
exact text and the JSON `code` from the browser's network tab (not the cookie, not the request body).

## 2. What was wrong, and is fixed

These are real defects, each proven by a test that fails on the 2.0.2 code and passes on the patch. **None of them is shown to
be the cause of the production 401.**

1. **A request that was not a sign-in was reported as a wrong password.** An empty or cut-off body, non-JSON, or an email or
   password that is not text all fell through to `ERR_CREDENTIALS_INVALID`. A proxy that drops a request body therefore looks
   exactly like a wrong password. Now such a request is `400 ERR_BAD_REQUEST`. The decision depends only on the shape of the
   request, never on whether the account exists, so it discloses nothing about any account. (`server/index.ts`)
2. **A truncated or damaged stored hash could be accepted by a shorter comparison.** `Buffer.from(text, 'hex')` silently stops at
   the first bad digit and drops an odd trailing one, so a record cut short parsed as a shorter, weaker one: a one-byte
   "hash" accepts one wrong password in 256. Records are now used only if their fields are whole decimal integers with
   costs of at least 1 and their salt and key are complete even-length hex of at least 8 and 16 bytes. Every hash this code
   has written (16-byte salt, 32-byte key) is unaffected, and upper-case hex still verifies. One implementation of the parsing
   now serves both verifiers. (`server/identity.ts`)
3. **A failed disk write could leave a ghost account.** If the account write failed, the account stayed in memory: it could
   sign in until the next restart and then vanish, and if it was the first account it made every later attempt look like a
   non-first registration that the Genesis Invitation could no longer open. If the invitation write failed after the account
   write, an account existed whose recovery codes were never shown to anyone. Both are now rolled back in memory (and the
   half-made account is removed), the visitor gets an error, and the same invitation still works. (`server/store.ts`,
   `server/index.ts`)

Nothing else in authentication changed: the password policy, the Gmail rule, MFA, replay protection, lockout, rate limits,
invitation enforcement and the stored format are as in 2.0.2. No migration is needed and none is performed. **Consensus,
genesis, versions and every protocol parameter are untouched, so no network identity changes.**

## 3. Telling the possible causes apart on the real host (read-only)

`obsidian-interface/scripts/auth-diagnose.mjs` reads the accounts file with a plain `readFileSync`. It does not load the
interface's store module (which can move a damaged file aside), never writes, never calls the service, never touches the
failure counters or lock state, never prints a password, hash, salt, TOTP secret, recovery code, invitation or session, and
refuses to take a password from a pipe or the command line (it is typed at a hidden prompt).

| Possible cause | How the tool or a safe request tells |
| --- | --- |
| The account has MFA on: the right password answers 401 `ERR_MFA_REQUIRED` until a code is sent. The main site's form always shows a code field; the app front shows it only after being asked. | The tool prints `MFA enabled true`. In the browser's network tab the JSON `code` is `ERR_MFA_REQUIRED`, not `ERR_CREDENTIALS_INVALID`. |
| The typed password is not the registered one (autofill, keyboard layout, a different field, stray space) | `--check-password` computes the hash independently and says PASS or FAIL, and whether the build on disk agrees |
| The request body never arrived (proxy, size, encoding) | After the patch it is `400 ERR_BAD_REQUEST`; before it, it was indistinguishable. A `curl` with an empty JSON body to each public domain shows which code answers |
| The code on the host is not the code in the release (stale or mixed build) | `--build-dir` prints SHA-256 of the installed server files and runs the installed verifier and canonicaliser on public known answers |
| The service reads a different store from the one inspected | the process's actual command line and working directory (commands below); a `--data-dir` flag wins over `OBSIDIAN_INTERFACE_DATA_DIR`, and with neither the store is `./.data` |
| The address typed is not a usable Gmail address, or no account has that canonical form | the tool says so (both answer the same 401 by design) |
| The deployed app front is not this release's | compare the SHA-256 of `real.mjs` and `data.mjs` fetched from the public domain with the files in the release |

Rate limits answer **429**, and a lock answers **429**; neither can be the 401. The tool reports the stored failure counter and any lock without changing either.

## 4. Deployment plan (not executed)

Every command is for the operator to run on the VPS, after review. Nothing here was run by the person or tool that wrote it.
Stop at the first unexpected result; do not retry in a loop, and never type a password anywhere but the browser or the tool's
hidden prompt.

### 4.0 Record the starting point (read-only)

```bash
cd /home/ubuntu/obsidian-mainnet-v2.0.2 && git rev-parse HEAD && git status --short | head
systemctl show obsidian-interface@mainnet -p MainPID -p User -p FragmentPath -p ExecStart -p ActiveEnterTimestamp --no-pager
PID=$(systemctl show -p MainPID --value obsidian-interface@mainnet)
sudo tr '\0' ' ' < /proc/$PID/cmdline; echo; sudo readlink /proc/$PID/cwd
systemctl list-units 'obsidian-*' --no-pager
ps -eo pid,user,lstart,cmd | grep '[s]erver/main.js'
sudo ss -ltnp | grep -E ':(8788|8789|8790|8791|8630)\b'
# names of the variables in the environment file, never their values:
sudo grep -E '^[A-Za-z_]+=' /etc/obsidian/mainnet/interface.env | cut -d= -f1 | sort
sudo sha256sum /opt/obsidian/obsidian-interface/dist/server/{index,store,identity,main}.js
node --version; df -h /var/lib/obsidian /opt/obsidian /root
curl -s http://127.0.0.1:8630/status | head -c 400; echo      # chain id and height, to compare afterwards
```

Expected: exactly one `obsidian-interface@mainnet` process, user `obsidian`, working directory
`/opt/obsidian/obsidian-interface`, a command line ending `--network mainnet --data-dir /var/lib/obsidian/mainnet/interface`,
and enough free space for a few megabytes.

### 4.1 Diagnose before changing anything

```bash
cp /home/ubuntu/obsidian-mainnet-v2.0.2/obsidian-interface/scripts/auth-diagnose.mjs /tmp/auth-diagnose.mjs   # from the patch checkout
sudo -u obsidian node /tmp/auth-diagnose.mjs --data-dir /var/lib/obsidian/mainnet/interface \
  --build-dir /opt/obsidian/obsidian-interface/dist/server --email YOUR_GMAIL --check-password
```

Expected on a healthy account: every line PASS except informational ones. If the password check is PASS and MFA is on, the
401 was `ERR_MFA_REQUIRED`: enter the authenticator code in the app. If the password check is FAIL, the stored hash does not
match what was typed and **no code change will fix it**; do not reset anything; use a recovery code through the product's own
recovery flow if the password is truly lost. Do not repeat attempts against the live service.

### 4.2 Build outside the live installation

```bash
git clone --branch arena/96483648-obsidian-network https://github.com/EmoluxLabs/Obsidian-Network.git /home/ubuntu/obsidian-auth-patch
cd /home/ubuntu/obsidian-auth-patch && git log -1 --stat | head -40        # review: only the files in section 7
npm --prefix obsidian-core ci && npm --prefix obsidian-interface ci
OBSIDIAN_KEYSTORE_PASSPHRASE=test-passphrase-for-suites npm --prefix obsidian-interface run build
npm --prefix obsidian-interface test
```

Prove provenance before replacing anything: build the released tag the same way in a second directory and compare it with what
is installed.

```bash
git clone --branch v2.0.4 https://github.com/EmoluxLabs/Obsidian-Network.git /home/ubuntu/obsidian-auth-base   # same steps as above
diff -rq /home/ubuntu/obsidian-auth-base/obsidian-interface/dist /opt/obsidian/obsidian-interface/dist         # expected: no output
diff -rq /home/ubuntu/obsidian-auth-base/obsidian-interface/dist /home/ubuntu/obsidian-auth-patch/obsidian-interface/dist
```

Expected: the first diff is empty (the installed build is the release). The second lists exactly `server/index.js`,
`server/store.js`, `server/identity.js` (and their `.map`/`.d.ts`). **If the first diff is not empty, or the second names any
other file, stop: the provenance is unclear.**

### 4.3 Backup (protected, outside Git, never copied elsewhere)

```bash
B=/root/obsidian-auth-backup-$(date -u +%Y%m%dT%H%M%SZ)
sudo install -d -m 700 -o root -g root "$B"
sudo cp -a /var/lib/obsidian/mainnet/interface/interface-accounts.json "$B"/
sudo cp -a /etc/obsidian/mainnet/interface.env "$B"/
sudo cp -a /opt/obsidian/obsidian-interface/dist/server "$B"/dist-server
sudo sh -c "cd $B && sha256sum interface-accounts.json interface.env dist-server/*.js > SHA256SUMS"
sudo ls -l "$B"                       # modes preserved, owner root, directory 0700; do not cat the files
# a digest of who the accounts are, to compare afterwards (prints only a digest):
sudo jq -r '.accounts[]|[.accountId,.canonicalEmail,.passwordHash]|join(" ")' /var/lib/obsidian/mainnet/interface/interface-accounts.json | sha256sum
```

The accounts file is written atomically (temporary file, then rename), so the copy is whole even while the service runs.

### 4.4 Deploy only the three server files, restart only the interface

```bash
SRC=/home/ubuntu/obsidian-auth-patch/obsidian-interface/dist/server; DST=/opt/obsidian/obsidian-interface/dist/server
ls -l $DST/index.js                    # note the owner and mode, and use the same below
for f in index store identity; do sudo install -m 644 -o root -g root $SRC/$f.js $DST/$f.js; done
sudo systemctl restart obsidian-interface@mainnet
systemctl is-active obsidian-interface@mainnet
```

Do not touch `obsidian-node@mainnet`, the app or wallet services, nginx, `/etc/obsidian`, `/var/lib/obsidian` or any keystore.
The restart sends SIGTERM, which flushes pending session writes before exit.

### 4.5 Verify

```bash
curl -s http://127.0.0.1:8789/api/auth/config        # network mainnet, chainId 7777, accountsExist true, genesisInvite configured and redeemed
for h in obsmainnet.us.ci app.obsmainnet.us.ci; do   # no credentials: an empty body now says so, on both domains
  curl -s -X POST https://$h/api/auth/login -H 'content-type: application/json' -d '{}' -w ' [%{http_code}]\n'; done      # expect ERR_BAD_REQUEST [400]
sudo -u obsidian node /tmp/auth-diagnose.mjs --data-dir /var/lib/obsidian/mainnet/interface --build-dir /opt/obsidian/obsidian-interface/dist/server
sudo jq -r '.accounts[]|[.accountId,.canonicalEmail,.passwordHash]|join(" ")' /var/lib/obsidian/mainnet/interface/interface-accounts.json | sha256sum   # equals the digest from 4.3
sudo journalctl -u obsidian-interface@mainnet --since '10 min ago' --no-pager | grep -ciE 'error|exception'                   # expect 0 unexpected lines
curl -s http://127.0.0.1:8630/status | head -c 400; echo                                                                      # same chain id, height not lower
```

Then the user signs in **in the browser, typing credentials only there**, on both domains, and enters the authenticator code
if asked, and confirms the account page loads (which is `/api/auth/me`).

### 4.6 Rollback (application files only)

```bash
sudo cp -a "$B"/dist-server/. /opt/obsidian/obsidian-interface/dist/server/
sudo sha256sum /opt/obsidian/obsidian-interface/dist/server/{index,store,identity,main}.js     # equals the digests recorded in 4.0
sudo systemctl restart obsidian-interface@mainnet
```

**Never copy `interface-accounts.json` back from the backup.** The live file may hold sign-ups, sessions, invitations and
counters written since; the backup exists only for a disaster in which the live file itself is lost, and restoring it is then
a deliberate, separate decision. A failed deployment is investigated, not rolled back automatically.

## 5. Production checklist

Status of each item at the time of writing: `NOT RUN` means it has not been performed on the production host.

| # | Check | Status |
| --- | --- | --- |
| 1 | One interface process, user `obsidian`, expected command line and working directory | NOT RUN |
| 2 | Installed build identical to the released tag | NOT RUN |
| 3 | Read-only diagnosis of the account, including the typed-password check | NOT RUN |
| 4 | Backup made, 0700, checksums recorded | NOT RUN |
| 5 | Only the three server files replaced; node, nginx, app and wallet services untouched | NOT RUN |
| 6 | `/api/auth/config` still `mainnet`, `7777`, accounts exist, invitation redeemed | NOT RUN |
| 7 | Account digest identical before and after | NOT RUN |
| 8 | Empty-body sign-in answers `ERR_BAD_REQUEST` on both domains | NOT RUN |
| 9 | User signs in on the main site in the browser (MFA code if asked) | NOT RUN |
| 10 | User signs in on the app domain in the browser (MFA code if asked) | NOT RUN |
| 11 | `/api/auth/me` succeeds after sign-in on both domains | NOT RUN |
| 12 | Logs show no unexpected authentication errors and no secrets | NOT RUN |
| 13 | Node healthy, chain id 7777, height not lower | NOT RUN |

## 6. Residual risks, not changed

* **A damaged accounts file starts the interface empty.** If `interface-accounts.json` ever fails to parse, the store moves it
  aside as `interface-accounts.json.corrupt-<time>` and starts with no accounts; the Genesis Invitation is then configured
  again from `OBSIDIAN_GENESIS_INVITE_HASH`, so the same invitation could register a new first account. Writes are atomic
  and fsynced, which makes this unlikely, but keep the protected backup, watch for `*.corrupt-*` files, and treat one
  as an incident. Changing this is a design decision, not part of this repair.
* **Behind the app front, `APP_TRUST_PROXY=true` must be set** (the example environment file does). Without it the platform
  sees every visitor as one address, so ten wrong passwords by anyone block everyone on the app domain for that account
  (a 429, not a 401).
* No password reset exists by design; recovery is by recovery code.

## 7. Data-protection statement

Files changed by the patch: `obsidian-interface/server/identity.ts`, `server/store.ts`, `server/index.ts`; new
`obsidian-interface/scripts/auth-diagnose.mjs`, `tests/auth-flow.test.ts`, `tests/auth-diagnose.test.ts`,
`obsidian-app-web/tests/signin-errors.test.mjs`; documentation (this file, the documentation index, the changelog).

* No consensus code, genesis file, protocol parameter, version number, chain id, node storage, keystore, wallet file, gate key,
  environment file or deployment configuration is changed.
* The patch contains no production account, password, hash, invitation, TOTP secret, recovery code or session. Every test and
  every local run used its own temporary directory, an invitation it generated itself, and invented addresses and passwords.
* The production account store, Genesis Invitation record, wallets and chain were not read, written, reset, regenerated or
  migrated by this work, and no migration is required by the patch.
