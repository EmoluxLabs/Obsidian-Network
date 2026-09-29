# Mining OBS

Mining on Obsidian is a **protocol claim**, not a browser game. The node decides
whether you are eligible, how much the claim pays, and which claim id is next;
the browser only signs and submits. Nothing in the interface can create a claim
that a node would not have accepted.

## 1. The schedule

| Parameter | Value |
| --- | --- |
| Claim interval | 4 hours (`claimIntervalSeconds = 14400`) |
| Claims per cycle | 6 per 24 hours (`maxClaimsPerCycle = 6`) |
| Initial daily reward | 0.001 OBS/day |
| Reward per claim | 0.000166666666666666 OBS |
| Reduction | −0.5% per 100,000 active miners |
| Hard floor | 0.0002 OBS/day |
| Active miner window | 30 days with at least one valid claim |

Read it live from any node:

```bash
curl -s http://127.0.0.1:8630/mining/schedule | jq
```

The schedule is recomputed from chain state on every node. The website formats
it; it does not own it.

## 2. Eligibility

```bash
curl -s "http://127.0.0.1:8630/mining/status?address=obs1…" | jq
```

The response tells you `eligible`, `secondsRemaining`, `claimsThisCycle`,
`claimsRemainingInCycle`, `nextClaimId`, `nextClaimSequence` and
`rewardPerClaimObs`, all derived from the **chain head timestamp**, never from
your device clock. A device with a wrong clock can display a wrong countdown; it
cannot produce an eligible claim.

Rejections you may see, and what they mean:

| Code | Meaning |
| --- | --- |
| `ERR_MINING_TOO_SOON` | fewer than 4 hours (protocol time) since this wallet's last claim |
| `ERR_MINING_CYCLE_LIMIT` | this wallet already claimed 6 times in the current cycle |
| `ERR_MINING_CLAIMED` | this claim id (or sequence) was already claimed |
| `ERR_MINING_UNKNOWN_WALLET` | the claim is not bound to a wallet with balance history — the wallet must exist first |
| `ERR_BAD_NONCE` / `REPLAY` | the same signed claim is being replayed, e.g. from a second tab |

## 3. Replay and concurrency

Each claim carries:

* a unique `claimId` derived by the node (never invented by the client),
* a `claimSequence` for that wallet,
* the wallet's next nonce.

The protocol enforces **one claim per wallet per block**, so two tabs, two
devices or two nodes cannot double-claim. A mined claim cannot be re-mined: the
transaction id is already spent and the sequence has advanced. The interface
deliberately does not retry with a fresh nonce on an ambiguous error — it
re-reads `/mining/status` and shows you what the chain says.

## 4. Genesis allocation

The very first valid claim on a chain receives **100,000 OBS** in addition to its
normal reward, atomically, exactly once. That wallet becomes the treasury wallet.
After that, the same conditions pay only the ordinary reward — verified in the
core suite by mining twice and asserting the second claim is not funded.

## 5. Withdrawals

Mining rewards land in the wallet that claimed them. Moving them is an ordinary
`PAYMENT`: no KYC, no lock-up, no activation token, no minimum. You pay the
standard gas (0.02%, capped at 0.01 OBS), which returns to the Mining Pool — the
same pool that pays mining rewards.

There is **no** `$5` activation, **no** WAC requirement, and **no** native
exchange inside the protocol. Price discovery happens on external markets; see
[removal-report.md](removal-report.md) for how to verify that from a running
node rather than from this sentence.

## 6. What mining is not

* It is not a browser hashrate contest, and it is not a hashrate contest of any
  other kind: Obsidian is a Proof of Time chain, so no participant gains
  anything by computing faster. Consensus does not depend on how long a tab
  stays open either — the only requirement is a signed claim that the protocol
  clock permits. See [proof-of-time.md](proof-of-time.md).
* It is not instantaneous wealth: at launch a claim pays 0.000166666666666666
  OBS. The schedule is designed to distribute 21,000,000 OBS over a very long
  horizon and to fall as participation rises.
* It is not permissioned by the interface. If this website disappeared, you could
  mine with a node, a script and the same signed-transaction format documented in
  [transaction-format.md](transaction-format.md).
