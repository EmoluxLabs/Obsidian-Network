# Wallets

A wallet on Obsidian is a secp256k1 key pair. Everything else — the interface,
your Google account, this documentation — is optional.

## 1. Where keys are created

Keys are generated **in your browser** from the WebCrypto CSPRNG
(`crypto.getRandomValues`). They are never derived from an email address, a
Google subject id, a username, a date of birth, an account id or anything else
guessable. The recovery phrase is 24 BIP-39 words (256 bits of entropy) and the
derivation path is `m/44'/7777'/0'/0/<index>`.

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
  "iterations": 210000,
  "salt": "<base64, 16 bytes>",
  "iv": "<base64, 12 bytes>",
  "ciphertext": "<base64, AES-256-GCM>",
  "address": "obs1…",
  "createdAt": 1790500000000
}
```

A wrong passphrase fails the GCM tag check and produces an error, not a
half-restored wallet. Nothing about the vault requires a server: restore it on any
device by entering the phrase.

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

## 5. What can go wrong

| Risk | Reality |
| --- | --- |
| Malicious interface | It can lie to you in the UI, but it cannot sign for you. Verify by reading a node you run and comparing the transaction id. |
| Malicious browser extension | It can read the page while unlocked. Use a clean profile for large balances. |
| Phishing | No legitimate Obsidian page will ever ask for your phrase. The interface has no such input. |
| Lost device | Restore from the phrase. If you never wrote it down, the wallet is gone. |
| Address typo | bech32m includes a checksum; a corrupted address is rejected by nodes rather than sending funds into the void. |

## 6. Addresses

```
bech32m(hrp, ripemd160(sha256(compressed_public_key)))
```

`hrp` is `obs` on mainnet, `tobs` (testnet), `sobs` (staging), `dobs` (devnet).
Explorer output masks addresses and never exposes balances: an explorer that
answers "how much does this wallet hold" is a surveillance tool, and this one
deliberately is not (see [explorer.md](explorer.md)).
