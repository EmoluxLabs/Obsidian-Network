# Transaction format

Everything in this document is implemented in
`obsidian-core/src/protocol/encoding.ts`, `obsidian-core/src/protocol/domains.ts`,
`obsidian-core/src/crypto/{keys,hash,bech32}.ts` and
`obsidian-core/src/transactions/encode.ts`. The browser wallet runs the same
modules — `obsidian-interface/scripts/sync-core.mjs` copies them from the compiled
core and fails the build if a Node built-in appears anywhere on that path. That is
why a transaction signed in a browser verifies in a node: it is not a
reimplementation, it is the same code.

## 1. Canonical encoding

| Rule | |
| --- | --- |
| Integers | big-endian, minimal fixed width that fits while preserving sign (`u8`/`u16`/`u32`/`u64`/`u128`) |
| Byte strings | `u32` length prefix, then bytes |
| Strings | UTF-8, `u32` byte-length prefix |
| Lists | `u32` length prefix, then elements |
| Booleans | one byte, `0x00`/`0x01` |
| Field order | fixed by the schema; never implicit, never sorted at runtime |
| JSON | RPC/UI only — never in a hashing or signing path |

Domain separation is mandatory: every hash prepends one ASCII tag from
`protocol/domains.ts`, so a transaction id can never equal a block id and a
signature over one object type cannot be replayed as another.

```
OBSIDIAN:TX_SIGNING:v1   signed digest
OBSIDIAN:TX:v1           transaction id
OBSIDIAN:BLOCK_HEADER:v1 block header hash
OBSIDIAN:BLOCK:v1        block hash
OBSIDIAN:GENESIS_ID:v1   genesis id
OBSIDIAN:NODE_METADATA:v1 signed node descriptors
OBSIDIAN:RELEASE:v1      release signatures
…
```

## 2. Envelope

```
protocolVersion : string   e.g. "1.7.0"
chainId         : u32      7777 mainnet / 7778 / 7779 / 7780
sender          : string   bech32m address
nonce           : u64      next nonce for the account
type            : u8       see the type table in protocol.md
gas             : u128     seals (1 OBS = 1e18 seals)
body            : bytes    canonical, type-specific
validUntil      : u64      absolute protocol time
memo            : string?  ≤ 256 bytes
signature       : { publicKey: 33-byte compressed, signature: 64-byte compact }
```

Limits enforced by the node (and by the mempool before it accepts anything):

| Limit | Value |
| --- | --- |
| Transaction size | 16 KiB |
| Memo | 256 bytes |
| Events emitted | 64 |
| Validity window | 240 blocks ≈ 1,200 s |

## 3. Signing

```
digest    = sha256( "OBSIDIAN:TX_SIGNING:v1" | encodeSigningPreimage(unsignedTx) )
signature = secp256k1.sign(digest, privateKey, { lowS: true, prehash: false })   → 64 bytes
txId      = sha256( "OBSIDIAN:TX:v1" | preimage | publicKey | signature )
```

* Low-S only, so a signature has exactly one acceptable encoding.
* The public key travels with the signature; the node derives the address from it
  and rejects the transaction if it does not match `sender` (`ERR_BAD_SENDER`).
* `validUntil` is checked against the **protocol time** of the block that would
  include it — not against the wall clock, and not against the client's claim.

## 4. Addresses

```
digest  = ripemd160(sha256(compressedPublicKey))
address = bech32m(hrp, digest)          hrp: obs | tobs | sobs | dobs
```

bech32m includes a checksum, so a mistyped address fails to decode instead of
sending funds into an unspendable void. The `hrp` differs per network, so a
mainnet address pasted into a devnet transaction is rejected.

## 5. Gas

```
gas = min(amount * 2 / 10_000, 0.01 OBS)     // 2 basis points, capped
```

* `POST /tx/gas` and the wallet's `expectedGas()` return the same number — the
  wallet imports the core function.
* A transaction that declares less is rejected with `ERR_BAD_GAS`; declaring more
  is accepted but never refunded, because the excess is still protocol fee.
* 100% of gas is credited to the Mining Pool.

## 6. Submitting without any interface

```bash
# 1. ask a node for the next nonce and a watermarked validity window
curl -s -X POST localhost:8630/wallet/quote -d '{"address":"obs1…"}' | jq

# 2. build the body with the same encoder the node uses
node --input-type=module -e "
import { encodePaymentBody } from './obsidian-core/dist/transactions/executors/payment.js';
import { signTransaction, encodeSignedTx } from './obsidian-core/dist/transactions/encode.js';
import { formatObs, parseObs } from './obsidian-core/dist/protocol/amount.js';
import { expectedGas } from './obsidian-core/dist/transactions/helpers.js';
const amount = parseObs('10');
const tx = signTransaction({
  protocolVersion: '1.7.0', chainId: 7780,
  sender: 'dobs1…', nonce: 1, type: 1,
  gas: expectedGas(amount),
  body: encodePaymentBody({ to: 'dobs1…', amount }),
  validUntil: <protocolTime + 600>,
  privateKeyHex: process.env.OBS_PRIVATE_KEY, publicKeyHex: process.env.OBS_PUBLIC_KEY,
});
console.log(encodeSignedTx(tx).toString('hex'));
"

# 3. submit the signed bytes
curl -s -X POST localhost:8630/tx/submit -d '{"tx":"<hex from step 2>"}' | jq
```

Step 2 can run entirely offline — signing needs nothing but the key and the
envelope. Only step 3 needs a node, and any node will do.

## 7. Verifying someone else's transaction

```bash
curl -s localhost:8630/tx/<txid> | jq          # description, masked addresses
curl -s -X POST localhost:8630/tx/simulate -d '{"tx":"<hex>"}' | jq   # what it would do
```

`/tx/simulate` applies the transaction to a copy of current state and reports the
resulting balance changes, events and error (if any) without committing anything.
It is the fastest way to answer "what does this actually do?" before you submit
it — or before you trust an interface that says it will do something.
