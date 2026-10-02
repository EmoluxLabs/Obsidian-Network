# Explorer

The explorer shows blocks, transactions, names, parcels and capsules read directly
from Obsidian Core nodes. It shows things deliberately *not* shown as well.

## 1. The two rules

**Rule 1 — never expose wallet balances.** A blockchain where anyone can look up
"how much does this wallet hold" is a surveillance system with extra steps. The
explorer surface does not answer that question: the interface's own node proxy
does not expose `/wallet/balance` on explorer routes, and the core's explorer
routes mask addresses before they leave the node.

**Rule 2 — transaction identifiers are not wallet addresses.** Block ids and
transaction ids use their own format, so a wallet address can never be confused
with a hash, pasted into a "search by address" box, or scraped as one. An
address that appears next to a transaction is **masked**
(`dobs1xzsgw…el4dfz`): enough to correlate two transactions of the same author,
never enough to reuse or to look up holdings.

## 2. What you can look up

| Input | Result |
| --- | --- |
| block height or block id | header fields, transaction count, size, timestamp |
| transaction id | inclusion height, type, amount, gas, masked sender and recipient |
| `name.obs` | owner, address, registration height, expiry, transferability |
| parcel id | owner, division, area, GLV at purchase, official value, MSP |
| capsule id | commitment, unlock time, status |

```bash
curl -s http://127.0.0.1:8630/blocks?limit=10 | jq
curl -s http://127.0.0.1:8630/tx/<txid> | jq
curl -s "http://127.0.0.1:8630/address/<address>?limit=20" | jq
```

The `/address/<address>` route returns *activity* — the transactions involving an
address, masked — and states in its own response that balances are never exposed:

```json
{
  "address": "obs1abc…123456",
  "maskNote": "Public explorer output: counterparties and this address are partially masked. Balances are never exposed.",
  "transactions": [ … ]
}
```

## 3. Chain health

The explorer also renders what a chain needs to be checkable by its users:

* height, head hash, genesis id and params hash;
* peer count and node latency, with the interface naming the node that answered;
* total supply against the 21,000,000 cap;
* the genesis allocation state (claimed / unclaimed, amount, recipient);
* `/audit/decentralization` — mining distribution and node counts;
* `/audit/compliance` — the absent mechanisms, read from the running protocol.

## 4. Why honesty beats polish here

An explorer that shows a *cached* balance, a *predicted* inclusion or a
*synthesised* fee is worse than no explorer, because it teaches users to trust a
number that the chain never agreed to. This one shows chain data with its
provenance attached (`x-obsidian-node`), and when it cannot reach a node it says
so instead of guessing.
