# Removed mechanisms, and how to verify it yourself

This project previously contained mechanisms that have been removed. Whether they
are gone is not a matter of opinion: a running node answers the question.

## 1. Verify from a live node

```bash
curl -s http://127.0.0.1:8630/audit/compliance | jq
```

```json
{
  "wac":                            { "present": false, "priceUsd": "0" },
  "legacyGenesisAllocation":        { "present": false, "amount": "0" },
  "signupAllocation":               { "present": false, "amount": "0" },
  "miningKyc":                      { "present": false },
  "miningWithdrawalRequiresWac":    { "present": false },
  "nativeExchange":                 { "present": false },
  "explorerExposesBalances":        { "present": false },

  "proofOfWorkConsensus":           { "present": false },
  "blockHeaderNonce":               { "present": false },
  "selfReportedNodeMetrics":        { "present": false },
  "adminRewardOverride":            { "present": false },
  "gasCountedAsPlatformRevenue":    { "present": false },
  "nodeIdentityIsIpAddress":        { "present": false },
  "revenueSplitEnforced":           { "present": true, "evidence": "40% node runners / 60% treasury, applied in the state transition" }
}
```

The second group answers the newer questions the same way, from the same
parameters:

| Key | What `present: false` proves |
| --- | --- |
| `proofOfWorkConsensus` | the running consensus identity is `PROOF_OF_TIME` and the fork-choice rule is `POT_WEIGHT_THEN_TIME_THEN_LOWEST_HEADER_HASH` |
| `blockHeaderNonce` | there is no nonce in the block header, so there is nothing to grind |
| `selfReportedNodeMetrics` | the node registry has no uptime, efficiency or hash-rate field; uptime needs signatures from *other* nodes |
| `adminRewardOverride` | no route, flag or parameter accepts an operator-supplied payout — settlement is a block routine |
| `gasCountedAsPlatformRevenue` | gas goes to the Mining Pool and is never routed through the 40/60 split |
| `nodeIdentityIsIpAddress` | a node identity is a secp256k1 key hash; the endpoint is an unverified hint |

`revenueSplitEnforced` is the one deliberately positive row: it reports that the
split exists, with the numbers the running binary uses.

`present: false` is computed from the protocol parameters the state machine reads
(`legacyGenesisAllocationRemoved` is literally `0n`, `wacEnabled` is literally
`false` — see `obsidian-core/src/protocol/params.ts`), and the withdrawal path
contains no reference to either mechanism. If any of these ever reported `true`, the binary in front of you still
implements the mechanism, whatever the documentation says.

## 2. Verify from the source

```bash
# the parameter set the whole protocol reads from
grep -n "wacEnabled\|miningKycRequired\|nativeExchangeEnabled\|newAccountBalanceObs\|maxInvitesPerAccount" \
  obsidian-core/src/protocol/params.ts

# the compliance flags come from one place, and the removal is a constant, not a claim
grep -n "wacEnabled\|legacyGenesisAllocationRemoved\|miningKycRequired\|nativeExchangeEnabled" \
  obsidian-core/src/protocol/params.ts

# "activation" appears only in the business-page price (an ordinary purchase),
# never as a gate in front of mining or withdrawals
grep -rn "activation" obsidian-core/src/

# the only issuance paths
grep -rn "GENESIS_ALLOCATION\|MINING_REWARD" obsidian-core/src/blockchain/state-machine.ts
```

## 3. What each removal means in practice

| Removed | Before | Now |
| --- | --- | --- |
| `$5 USDT` activation | a payment gate in front of using the product | nothing to pay: registration creates an account with **0 OBS** |
| WAC purchase / generation | a second token required before mining or withdrawing | no second token exists in the codebase |
| WAC-gated withdrawal | withdrawals blocked without WAC | a payment is a payment: no gate, no KYC, only standard gas |
| 3,000,000 OBS genesis allocation | 3 M OBS created at signup, out of thin air | **100,000 OBS to the first protocol-valid mining claim**, atomically, once; `legacyGenesisAllocation.present = false` |
| Mining KYC | identity documents required to claim | claiming needs a wallet signature and nothing else |
| Native / personal exchange | an in-app exchange holding user funds | none: price discovery is external, and the interface never custodies |
| Explorer balances | balances visible per address | masked activity only; balance routes are not exposed on explorer surfaces |

## 4. What replaced them

* **Registration** creates an interface account (invite-only, max 5 invites) that
  holds no OBS and no key.
* **Wallets** are created in the browser, independently of any account, with keys
  that never reach the server.
* **The treasury wallet** is the wallet that received the genesis allocation. It
  is recorded on chain, readable at `/status` (`treasuryWallet`) and
  `/genesis`, and it is where platform revenue is routed — never user funds.
* **Value accrues through use**, not through a toll: gas returns to the Mining
  Pool, tips go entirely to creators, the network's 30% share of monetisation and
  the 0.005 OBS business-page fee go to the treasury.

## 5. Regression coverage

`obsidian-core/tests/security/protocol-security.test.ts` asserts, among other
things, that the genesis allocation can be claimed exactly once, that a second
miner is not funded by it, that a supply invariant violation is refused
(`SUPPLY_EXCEEDED`), that gas underpayment is rejected, and that a mined
transaction cannot be replayed. `tests/security/rpc-hardening.test.ts` asserts
that the explorer surfaces never return balances and that no response contains
private key material.
