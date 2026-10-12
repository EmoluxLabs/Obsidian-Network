# Wallet custody: who holds the keys, how they are stored, and what was and was not reviewed (1.8.1)

**Scope of the review.** This is the authors' own review of the wallet code in this repository, with tests. It is **not
a full browser, cryptography or third-party audit**, and it does not cover the operating system, the browser itself, a
compromised device, or the template apps' own dependencies beyond `npm audit`.

## 1. The rule

**Keys belong to the user.** A recovery phrase and its private keys are created in the user's own browser or app,
sealed there under the user's passphrase, and used there to sign. The platform (`obsidian-interface`) has no endpoint
that accepts a phrase, private key or passphrase, no code path that logs one, and stores only the **public** key and
address a user links (`tests/server.test.ts` "links a proven wallet address but never stores key material" checks the
store file). The wallet is an independent key: it is not derived from any account data, and one wallet links to one
account, permanently. Eligibility to claim is decided by consensus, not by the platform.

| Product | Where the vault lives | Format |
| --- | --- | --- |
| Web platform wallet (`obsidian-interface/web/src/lib/wallet.ts`) | browser `localStorage`, key `obsidian.vault.v1` | the vault below |
| Web app wallet (`obsidian-app-web/web/vault.mjs`) | same key, byte-compatible (`tests/vault-interop.test.mjs` opens each with the other's real code) | the vault below |
| Desktop node (`obsidian-node-desktop/src/core/vault.ts`) | a file on the user's disk | the vault below |
| Wallet web app (`obsidian-wallet-web`) | encrypted backup files the user downloads and re-imports | PBKDF2/AES-GCM backup with bounded parameters |

## 2. The vault

* **Versioned and authenticated.** `version: 1`; PBKDF2-HMAC-SHA256, **600,000 iterations** (vaults written with 210,000
  still open); AES-256-GCM with a fresh 16-byte salt and 12-byte IV on every write; passphrase NFKC-normalised, minimum
  12 characters. The GCM tag authenticates the ciphertext, so a flipped bit or a wrong passphrase fails the tag check
  and is reported as "wrong passphrase (or the vault was modified)"; garbage is never returned as a wallet.
* **The plaintext phrase and private key never appear in storage** and the vault's ciphertext is different every time
  (tests: round trip, no phrase words or key in the stored string).
* **Domain separation.** Transaction signatures use the `TX_SIGNING` digest over protocol version, **chain id**, sender,
  nonce, type, gas, body, expiry and memo; a signature for one chain does not verify with another chain id, and a
  wallet-link proof (`OBSIDIAN:WALLET_LINK:v1`) does not verify under any other domain (both tested in
  `tests/wallet-vault.test.ts`). Gate certificates and gate-update approvals have their own domains.

### Findings fixed in 1.8.1

| ID | Severity | Finding | Fix | Test |
| --- | --- | --- | --- | --- |
| W-1 | Medium | `Wallet.unlock` and `openVault` read the iteration count (and version, KDF, salt, IV lengths) from storage and handed it straight to the key-derivation function. Anything able to write the origin's storage could set `iterations` to billions and freeze the page, or feed malformed fields and get a raw `SyntaxError`/`InvalidCharacterError`. (AES-GCM authenticates the ciphertext, not these header fields.) | The envelope is validated **before** any work: version 1 only, KDF `PBKDF2-SHA256`, iterations 100,000 to 10,000,000, salt 8-64 bytes, IV 12 bytes, ciphertext 17 bytes to 256 KiB, valid base64, valid JSON. Every failure is a specific message ("damaged", "not supported", "outside the accepted range"). | `wallet-vault.test.ts` (17), `vault-interop.test.mjs` (11): out-of-range iterations are refused in under 250 ms |
| W-2 | Low | Signing in while presenting a session left that session alive. | `admit()` ends the session presented with the sign-in and always issues a fresh secret. A planted cookie value is never accepted (the store only knows tokens it issued). | `server.test.ts` "a planted session cookie is no credential" |
| W-3 | Low (docs) | `security-model.md` still said 210,000 iterations. | Corrected. | n/a |

The desktop vault and the wallet-web backup parser already validated these bounds.

## 3. Sessions and the page around the wallet

* The session cookie is `HttpOnly; SameSite=Lax; Path=/`, with `Secure` whenever the interface is told it is behind a TLS
  proxy (`OBSIDIAN_INTERFACE_TRUST_PROXY=true`). **If you serve it over HTTPS without that flag the cookie will not be
  `Secure`: set the flag.**
* Sessions last 14 days, are server-side (the cookie carries only a random secret), are ended by logout, by recovery
  (all of the account's sessions), and by expiry; across a failover see [failover-and-gateways.md](failover-and-gateways.md).
* The CSP is `default-src 'self'; script-src 'self'; connect-src 'self'; frame-src 'none'; frame-ancestors 'none';
  object-src 'none'; base-uri 'none'` (`style-src` allows inline styles). No inline script runs and the page cannot send
  data to another origin or be framed (tested in `tests/pages.test.ts` and `server.test.ts`).
* State-changing routes require a same-origin or allow-listed `Origin`; cross-origin credentialed calls are refused
  (`server.test.ts`, trusted-domains tests).

## 4. What cannot be defended, and what the user should do

* **Script running on the wallet's origin can read an unlocked wallet and the stored vault.** CSP and the absence of
  inline script reduce the chance; they do not remove it. Do not serve third-party scripts from the wallet origin and do
  not add one to the CSP.
* **The vault's header fields (`address`, `addressHrp`, `createdAt`) are not covered by the GCM tag**, so something that
  can write storage can change the address a locked page *displays*. The unlocked wallet always uses addresses derived
  from the decrypted phrase, and a mismatch is refused (`LegacyVaultError`). Binding the header as authenticated data
  needs a new vault version across four products; it was not done here and is listed in the risk register.
* **A passphrase is only as strong as the user's choice.** PBKDF2 at 600,000 iterations slows a guesser; it does not stop
  a short or reused passphrase.
* **"Export" writes the private key and phrase in the clear, on purpose**, to a file the user then owns. The warning is
  in the file. Nothing is uploaded.
* **No hardware-wallet support.** A user who needs it should use a hardware key outside this software.
* **A forgotten passphrase with no recovery phrase is an unrecoverable wallet.** No one, including the operators, can
  reset it.
* **Browser-level testing.** The vault and page logic are tested under jsdom and Node's WebCrypto, and the platform has
  an end-to-end browser harness for sign-in and claim flows; there has been **no** testing across real browsers, real
  extensions, or hostile extensions.
