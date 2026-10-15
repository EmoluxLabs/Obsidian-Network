# Node rewards — protocol 1.9.0

**Formula.** Per reward period,

```
reward(node) = nodePool × weight(node) / Σ weight(eligible nodes)
```

where `nodePool` is **90 %** of the ONS revenue accumulated in the node-runner pool, and `weight` counts **only eligible
nodes**. Everything below is integer arithmetic computed inside the block state machine by every node; there is no
reward server, no private database and no client-reported uptime.

Code: `obsidian-core/src/economy/{node-rewards,settlement,accounting}.ts`; parameters:
`CONSENSUS_PARAMS.nodeRewards`. Tests: `obsidian-core/tests/unit/node-rewards.test.ts`,
`tests/integration/node-runners.test.ts`. Operator view: [node-runner-rewards.md](node-runner-rewards.md).

## 1. Source of the pool

ONS registration and renewal fees are split **90 / 10**: `nodePool = floor(fee × 9000 / 10000)`; the remaining 10 % goes
to the treasury wallet (`splitOnsRevenue`, `accounting.ts`). The pool is consensus state. Nothing mints OBS for rewards: a
payout is a transfer out of the pool, so the supply cap and every supply rule are unchanged. Gas and mining flows are not
in this pool.

## 2. Period and settlement

* A period is `periodSeconds` = 86 400 s of **protocol time** (header timestamps), not of anyone's clock.
* The first block whose timestamp lands in a new period **settles the period that just closed**, inside that block, once:
  `lastSettledPeriod` is consensus state, so settling twice is impossible and every node settles at the same height.
* Wallet changes and reclaims scheduled for a period take effect **before** settlement, so the wallet paid is the one the
  protocol had recorded — never one introduced in the paying block.
* Every payout is an event (`NODE_REWARDS_SETTLED` and the per-period summary in `recentSettlements`), traceable per node and per
  period through `/nodes/status/:nodeId` and the explorer.

## 3. How uptime is measured (no self-report)

The only things that count are statements the chain **contains**:

| Evidence | Rule |
| --- | --- |
| **Heartbeat** | Signed by the node key, at most one per **uptime window** (1 h of protocol time, 24 per period). It names its window and the protocol rejects any mismatch with the including block's timestamp; it carries the node's reported height, and a heartbeat more than `responsiveHeightLag` (12) blocks behind the including height is **stale** and does not count as uptime. |
| **Produced block** | A block the node's key signed proves the node was up in that block's window. |
| **Attestation** | Another registered node says it saw the subject online; only valid for a subject with recorded uptime in the same period; capped per attester; duplicates and lies are recorded as invalid. |
| **Fault report** | Corroborated by `minAttesters` (2) independent reporters before it changes a payout; one accusation alone changes nothing. |

There is **no field** in which a node can state "I was online 99 %". Selective reporting does not help: a node cannot make
a window appear that no block contains, and an attester cannot attest what the subject did not record.

## 4. Weight and eligibility

Integer basis points (bps). `uptimeBps = liveWindows × 10 000 / 24`, scaled down in proportion when fewer than
`minAttesters` distinct nodes attested it, and capped at 5 000 bps on a network with only one registered node (a lone node
cannot independently verify itself, and the protocol says so in `reasons`).

```
score = 40 % uptime + 25 % participation + 20 % reliability + 15 % responsiveness
```

Eligibility is a **gate**, not a bonus: a node is paid only if it is registered with a bound wallet, was registered **before
the period opened**, has `uptimeBps ≥ 5 000` and `score ≥ 1 000`. Ineligible nodes weigh zero and are paid nothing — an
offline node earns nothing.

> **Deviation from the literal formula — flagged.** The weight is the composite *score*, of which uptime is 40 %, not the
> uptime component alone. Participation (scheduled blocks produced, peers attested), reliability (corroborated faults and
> invalid attestations) and responsiveness (in-sync heartbeats) are scored in the same pass so that a node that is "up" but
> unsynced, absent from its slots or caught lying is paid less. If a pure-uptime weight is wanted, it is a one-line change in
> `scoreNode` and a protocol change.

Treatment of misbehaviour:

| Behaviour | Treatment |
| --- | --- |
| Downtime | Fewer live windows → lower uptime; below 5 000 bps → nothing. |
| Missed slots | Three misses suspend the node (no blocks, so lower participation). |
| Unsynced | A stale heartbeat earns no uptime window and lowers responsiveness. |
| Invalid attestations / corroborated faults | `−faultPenaltyBps` (2 000 bps) each from reliability. |
| Equivocation | Permanent ban: weight zero for ever, wallet released. |
| Registered mid-period | Not scored for that period; eligible at the next settlement. |
| Deregistered mid-period | That period's share is forfeited; settled payouts untouched (there is no bond). |

## 5. Precision, rounding, minimum payout, remainder

* **Exact largest-remainder** split of integer seals (1 seal = 10⁻¹⁸ OBS); nodes in a fixed order (by `nodeId`), ties
  broken in that order. No floating point anywhere, so every platform computes the same bits.
* **Per-node cap:** no node may take more than `max(5 %, ceil(100 % / n))` of the pool, so a small network is paid in full
  instead of stranding the pool; a capped node's overflow is redistributed to the others in the same pass.
* **Minimum payout:** an allocation below `minPayoutSeals` (10⁻⁶ OBS) is **not paid as dust**; it stays in the pool and
  carries into the next period.
* **No overpay, exactly once:** `Σ paid + carried = pool` is asserted before anything is written; a settlement can never
  mint a seal.

## 6. Sybil, multi-node operators, clock manipulation

* **Multi-node operators.** The protocol cannot tell one operator with ten nodes from ten operators; each registered node
  earns on its own evidence. The per-node cap, the independent-attester requirement and the registration-rate limits restrict
  what one fleet takes from honest nodes — nothing more. This is a limit, not a solved problem.
* **Clock manipulation.** Time comes from header timestamps bounded by the median-time-past and a 60 s future-drift rule
  ([consensus-v1.9.0.md](consensus-v1.9.0.md) §5). A heartbeat for another window than the block's is rejected.
* **Replay.** Heartbeats and attestations are per-window/per-period and idempotent against state; a replayed statement is
  rejected (`NODE_HEARTBEAT_TOO_SOON`) or ignored; transactions also carry nonces and expire.
* **Selective reporting.** Evidence is only what the chain contains; unreported time is simply not counted.

## 7. Who is eligible, and who is not

Full nodes that stay online and in sync (PCs, home servers, a deliberately-run always-on phone) can earn. **Light clients and
wallets do not**, and a phone is not automatically eligible. Nodes need no VPS. Node keys stay with the operator; binding a
wallet needs no signature ([node-binding-v1.9.0.md](node-binding-v1.9.0.md)).
