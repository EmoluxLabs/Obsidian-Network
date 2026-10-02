# Time Capsule Wall

Seal something today. The chain remembers the commitment, the lock, and the
unlock time — and it opens without you.

## 1. What a capsule is on chain

| Field | Meaning |
| --- | --- |
| `capsuleId` | Deterministic id: `bech32m(obsid, sha256(contentCommitment + owner + unlockAt + nonce))` |
| `contentCommitment` | SHA-256 of the encrypted payload, computed **in the browser** |
| `contentBytes` | Size of the encrypted payload |
| `contentNonce` | AEAD nonce, published so others can decrypt the payload if they have the key |
| `unlockAt` | Absolute protocol time |
| `commitment` | OBS locked by the creator — **minimum 0.0001 OBS** |
| `status` | `sealed` until `unlockAt`, then `unlocked` |

The payload itself is **never** on chain: only its fingerprint. That keeps the
chain compact and means a capsule cannot be opened by reading a block explorer.

## 2. The lock is not a balance

When you seal a capsule, `commitment` is removed from your balance and recorded
as locked. It counts toward the supply invariant while locked (so the ledger
always balances) and it is **not refundable**.

At `unlockAt`, by pure state transition:

* the locked commitment is transferred to the **Mining Pool**;
* `status` becomes `unlocked` and the events record it;
* no transaction, no signature and no online party is required — a capsule whose
  creator deleted their wallet, their node and their laptop still unlocks on time.

The core suite asserts the pool delta explicitly, which is why the numbers in the
test include `expectedGas`.

## 3. Time Travel preview

A sealed capsule can be peeked at:

* price: **1000 × the creator's commitment**, paid in one transaction;
* destination: 100% to the Mining Pool (the creator is not paid for a preview);
* limit: **once per capsule per account**;
* duration: 30 seconds of preview access (`previewSeconds`).

What a preview exposes is the **public teaser** the creator chose to publish at
creation time, plus protocol-recorded access to the preview slice. It does not
decrypt the sealed payload — see the honest limitation below.

## 4. The honest limitation

A protocol cannot invent a secret out of nothing, and it cannot force an offline
party to reveal a key. So:

* **What the chain guarantees**: the commitment is immutable, the lock is
  irreversible, the unlock happens on time without the creator, and preview
  access is priced, unique and recorded.
* **What the chain cannot guarantee**: that a preview reveals genuinely secret
  content. The content that must stay secret is the AEAD ciphertext in *your*
  capsule file. A creator who wants a real reveal at unlock time must publish the
  key in a transaction at or after `unlockAt` (a `REVEAL`), and anyone holding the
  file can then decrypt and verify it against `contentCommitment`.

This is stated in the interface, in the capsule file itself and here, because a
user who expects magic will be disappointed, and a user who understands the
mechanism gets exactly what a permanence layer can actually provide.

## 5. Keeping your capsule

Sealing writes a text file: the commitment, the nonce, the unlock time, the
creator address, the teaser, and the base64 sealed content. Anyone can recompute
the commitment from that file and check it against the chain:

```bash
# recompute the commitment the way the browser did
node -e "
const c=require('node:crypto');
const content='<the sealed content>';
const nonce='<the nonce from the file>';
const data=Buffer.from('OBSIDIAN_CAPSULE_V1|'+nonce+'|'+content,'utf8');
console.log(c.createHash('sha256').update(data).digest('hex'));
"
curl -s http://127.0.0.1:8630/capsules/<capsuleId> | jq .contentCommitment
```

If the two digests match, your file is the file the chain is holding a
fingerprint of. If they do not, the file was altered.

## 6. Statistics

`GET /capsules` returns every capsule with its commitment, unlock time, status
and owner, plus counts the interface renders as "capsules on the wall", "still
sealed", "unlocked" and "OBS locked". Those numbers come from chain state, so two
interfaces on the same chain show the same wall.
