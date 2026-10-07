# Wallets

A wallet on Obsidian is a secp256k1 key pair. Everything else — the interface,
your interface account, this documentation — is optional.

## 1. Where keys are created

Keys are generated **in your browser** from the WebCrypto CSPRNG
(`crypto.getRandomValues`). They are never derived from an email address, a
username, a date of birth, an account id or anything else guessable. The
recovery phrase is 24 BIP-39 words (256 bits of entropy) and the derivation is
standard BIP-32/BIP-44, path `m/44'/7777'/0'/0/<index>`.

**WebCrypto is only available on secure origins**: an HTTPS page, or
`http://localhost` / `http://127.0.0.1`. Opened at a plain-HTTP LAN address such
as `http://192.168.1.42:38788`, the wallet page says so and offers no form,
rather than failing after you have typed a passphrase. Use the device that runs
the interface, or serve it over HTTPS.

`obsidian-interface/web/src/lib/wallet.ts` is short enough to read end to end.
Two properties are worth checking yourself:

* no function in it performs a network request with key material;
* the vault it persists contains only `{kdf, salt, iv, ciphertext}` — the private
  key never appears in `localStorage` in plaintext.

## 2. Vault format

```json
{
  "version": 1,
  "kdf": "PBKDF2-SHA256",
  "iterations": 600000,
  "salt": "<base64, 16 bytes>",
  "iv": "<base64, 12 bytes>",
  "ciphertext": "<base64, AES-256-GCM>",
  "address": "dobs1…",
  "addressHrp": "dobs",
  "createdAt": 1790500000000
}
```

The vault passphrase must be at least 12 characters and is NFKC-normalised before
use, so the same passphrase typed on two keyboards opens the same vault. A wrong
passphrase fails the GCM tag check and produces an error, not a half-restored
wallet. Nothing about the vault requires a server: restore it on any device by
entering the phrase. Vaults written with fewer iterations by earlier releases
still open, because the iteration count is stored in the file; so do vaults
written before passphrases were normalised, which are retried with the passphrase
exactly as typed. New vaults always use the current 600,000.

A vault created by a release **before 1.3.0** holds keys that 1.3.0's standard
derivation can no longer reproduce from the phrase. Unlocking one says so
(`LegacyVaultError`) instead of producing signatures the node would reject with a
bare "bad signature". No mainnet existed before 1.3.0, so nothing of value can
be on such a wallet: create a new one.

## 3. Signing

The browser wallet builds transaction bodies with the **same encoder the node
runs** — `obsidian-interface/web/core/` is copied from the compiled core by
`scripts/sync-core.mjs`, and the build fails if any module on that path imports a
Node built-in. The signed bytes are the only thing that leaves the browser.

The interface server will store an **address** you choose to publish (so the
account page can show which wallet you mine with). It has no code path that
accepts a private key, a phrase or a signed blob it could replay, and its test
suite asserts that the account store never contains key material.

## 4. Export, backup, recovery

The wallet page exports a text bundle containing the address, the private key and
the recovery phrase. Treat it as cash:

* the **recovery phrase** restores the wallet on any device, forever;
* the **private key** does the same for one address;
* if you lose both, the OBS is unrecoverable. Nobody — including Obsidian — can
  reverse that. It is not a policy; there is no key escrow to break into.

## 5. One phrase, one key, four networks

The derivation does not depend on the network: the same recovery phrase produces
the **same key pair** on mainnet, testnet, staging and devnet. Only the address
prefix (and its checksum) changes, so `obs1…`, `tobs1…`, `sobs1…` and `dobs1…`
from one phrase belong to one key. Transactions commit to the chain id, so a
signature made on one network is useless on another, but the key is still the
key. Therefore:

* **make a separate wallet for every network**, above all for mainnet;
* never type a mainnet phrase into a test network's interface, and never reuse a
  phrase you have shown on a screen, pasted into a chat or used on a shared
  device for anything you intend to keep.

## 6. What can go wrong

| Risk | Reality |
| --- | --- |
| Malicious interface | It can lie to you in the UI, but it cannot sign for you. Verify by reading a node you run and comparing the transaction id. |
| Malicious browser extension | It can read the page while unlocked. Use a clean profile for large balances. |
| Phishing | No legitimate Obsidian page will ever ask for your phrase. The interface has no such input. |
| Lost device | Restore from the phrase. If you never wrote it down, the wallet is gone. |
| Address typo | bech32m includes a checksum; a corrupted address is rejected by nodes rather than sending funds into the void. |

## 7. Addresses

```
bech32m(hrp, ripemd160(sha256(compressed_public_key)))
```

`hrp` is `obs` on mainnet, `tobs` (testnet), `sobs` (staging), `dobs` (devnet).
Explorer output masks addresses and never exposes balances: an explorer that
answers "how much does this wallet hold" is a surveillance tool, and this one
deliberately is not (see [explorer.md](explorer.md)).
