# Node ↔ reward-wallet binding — protocol 2.0.1 (introduced in 1.9.0)

The operator of a node **pastes an OBS address**. That is the whole binding step: no gas, no wallet signature, no wallet
key, no deposit, no bond. The binding is stored in protocol state, persists across restarts and is synchronised to every
node like any other state.

Code: `obsidian-core/src/transactions/executors/node-registry.ts` (rules), `obsidian-core/src/node-agent.ts` (the node's
own statements), `obsidian-core/src/cli/ops.ts` (`register`, `binding`). Tests:
`obsidian-core/tests/integration/node-runners.test.ts`, `tests/unit/node-agent.test.ts`.

## 1. How an operator binds

```bash
# 1. the node has its own identity key (created on first start; it never leaves this machine)
node dist/index.js keygen --network testnet --keystore ./node-key.json

# 2. paste the address that should be paid; this writes <data-dir>/node-binding.json and nothing else
node dist/index.js register obs1… --network testnet --data-dir ./data     # use the address prefix of your network

# 3. keep the node running with block production enabled; it registers ITSELF on chain with its own key
node dist/index.js binding --network testnet --data-dir ./data            # shows the file and the on-chain status
```

* The address is validated locally for the network (prefix and checksum) and stored canonical-lowercase. An invalid address
  is refused and **nothing** is written.
* No wallet is opened, asked for or signed with. **Never type a private key or recovery phrase into any node screen** —
  none asks for one, and a screen that does is not Obsidian.
* The on-chain `REGISTER` statement is an ordinary transaction whose sender is the node's own identity address; the usual
  signature check proves the node key made it. `nodeId = hash(node public key)` is verified. Gas is zero.

## 2. One node ↔ one active wallet

| Property | How it is enforced |
| --- | --- |
| A wallet backs at most one node | A consensus index `nodeByRewardWallet`. `REGISTER` or `CHANGE_WALLET` naming a wallet that already backs another node fails with `NODE_WALLET_IN_USE`. |
| Atomic, no partial reservation | The node record and the wallet index are written together by one state operation (`putNode`). If any check fails, the whole transaction fails and nothing is reserved. A block with a failing transaction is rejected as a whole. |
| Concurrency | Transactions in a block run strictly in order. If two nodes bind the same wallet in one block, the first is applied and the second is rejected, identically on every node. |
| No silent overwrite | Changing a node's wallet is a separate, **delayed** statement (§3). A wallet that backs a node cannot be bound to another. |
| Addresses | Node bindings are canonical-lowercase only: two spellings of one address cannot be two bindings. |
| Deregistration | `DEREGISTER` frees the wallet binding immediately; settled rewards stay paid; the period in progress is forfeited. |
| Ban | A node banned for equivocation loses its binding permanently; the wallet is free to bind again. |

## 3. Changing the wallet, and recovering a wallet that someone else bound

**Change (the operator's choice).** `CHANGE_WALLET`, signed by the node key, takes effect after `walletChangeDelayPeriods`
(2 reward periods). The incoming wallet is **reserved** at once, so nobody else can bind it meanwhile. The current wallet or
the node key may cancel the change before it takes effect. Rewards already paid stay with the wallet that earned them.

**Reclaim (the wallet owner's choice).** `RECLAIM_WALLET` is sent **from the bound address** — the only signature anywhere in
this flow that proves control of the wallet. The binding is released after `reclaimDelayPeriods` (1 period). Rewards keep
flowing to the wallet until then.

## 4. What the binding does **not** prove — squatting

**An unsigned binding does not prove that the operator owns the wallet.** Proving it would need a signature from the wallet,
and the requirement is that the operator needs none. So:

* Binding somebody else's address only **pays them**; a bound address is credited, never debited. A node that binds a stranger's
  address gives that stranger money.
* But one address backs one node, so a stranger can **squat** an address and keep its true owner from binding it to their own
  node until the owner reclaims it.
* The remedy is `RECLAIM_WALLET` (§3): one transaction from the wallet and a one-period delay. After release a squatter can
  bind it again, at the cost of a new node registration (rate-limited, 64-block maturity before it can count). **The protocol
  cannot make squatting impossible without a wallet signature; it makes it slow, rate-limited and reversible by the owner.**

This is a deliberate trade-off between "no signature to bind" and "no squatting". It is documented, not hidden.

## 5. The name wallet is not the reward wallet

An ONS name's resolved address ([ons.md](ons.md)) and a node's reward wallet are **different, independent records**. Editing
one never changes the other, and a name transfer never moves a node binding.

## 6. Eligibility to earn

A bound wallet alone earns nothing. Rewards need an **eligible** node: registered before the period opened, online and in
sync (recorded heartbeats and produced blocks), not banned. Offline nodes are not paid. See
[node-rewards-v1.9.0.md](node-rewards-v1.9.0.md).

## 7. Full node versus light client; PCs, home servers and phones

* A **full node** has an identity key, keeps the chain, verifies, relays and can be registered. It does **not** need a VPS: a PC
  or a home server with a reachable connection can run one.
* A **light client** (the extension, a wallet) reads from a node and has no identity on chain, no binding and no reward.
* A phone is **not automatically eligible**: it earns only if an operator deliberately runs a full node on it that stays
  online, in sync and reachable — and then it is held to the same rules as any node. Node keys stay with the operator.
