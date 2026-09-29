# FAQ

**Is this a real blockchain or a website that pretends to be one?**
There is no database of balances anywhere in this repository. State is derived by
applying blocks; two nodes independently reach the same state root. You can run a
node, restart it, wipe the interface entirely, and the chain is unchanged. The
tests in `obsidian-core/tests` start real chains, produce real blocks and assert
on resulting state.

**Can the website create OBS?**
No. The only issuance paths are the one-time genesis allocation (100,000 OBS to
the first valid mining claim) and mining rewards bounded by a schedule and a
21,000,000 OBS cap. Verify the invariant yourself: `curl -s localhost:8630/supply | jq`.

**What happened to the 3,000,000 OBS signup allocation?**
Removed. A running node reports `legacyGenesisAllocation.present = false` and
`signupAllocation.present = false` at `/audit/compliance`, and registration now
creates an account with **0 OBS**.

**Where did the $5 activation and WAC go?**
They no longer exist in the code. There is no second token, no activation fee and
no WAC gate on withdrawals: withdrawing mined OBS is an ordinary payment with the
ordinary gas fee, and no KYC is involved.

**Who holds my keys?**
You do, in your browser. They are generated locally, encrypted locally with your
passphrase, and never transmitted. Signing happens in the page. The interface
server has no signing endpoint and its store contains no key material.

**What if I lose my passphrase or my phrase?**
You lose the wallet. That is not a policy choice we can reverse for you — there is
no escrow, no recovery service and no admin override. It is the same property that
makes nobody able to freeze your OBS.

**How much does mining pay?**
0.001 OBS per day at launch, split into six claims of 0.000166666666666666 OBS,
reduced 0.5% per 100,000 active miners down to a floor of 0.0002 OBS/day. Not a
typo. Read `docs/mining.md`.

**Why is my mining countdown different from my clock?**
Because the protocol does not use your clock. Eligibility comes from the chain
head's timestamp. If your device clock is wrong, the display is wrong — the claim
is not.

**Do I need an account to mine, or to have a wallet?**
No. Wallets and mining need a wallet, not an account. Accounts exist only to gate
invites on the interface (5 per account, enforced by the server), and are optional
when the operator leaves the Google client id empty.

**Is the explorer hiding something?**
It hides wallet balances and masks addresses on purpose, so the chain cannot be
used to look up what someone holds. Block and transaction data, names, parcels and
capsules are all visible. See `docs/explorer.md`.

**What happens if Cloudflare (or this website) disappears?**
Nothing happens to the chain. Nodes keep producing blocks. Run the node and the
interface yourself, or read the RPC directly — the format is documented in
`docs/api.md`.

**What happens if the dollar price feed dies?**
Everything priced in dollars — ONS registration, business pages, land — closes
with `ERR_ORACLE_UNAVAILABLE`. The protocol refuses rather than guessing, and
nothing about consensus depends on the oracle.

**Can Obsidian take a cut of my tips?**
No. Tips go 100% to the creator. The protocol's revenue comes from gas (to the
Mining Pool), ONS registration fees, land protocol sales, the $50 business page
and the network's 30% share of monetised creator revenue — all recorded on chain.

**Where does that revenue go?**
Qualifying platform revenue is split 40/60 the moment it is received: 40% to the
Node Runner Reward Pool, 60% to the treasury wallet designated by the genesis
rule. Gas is the exception — it funds the Mining Pool and is never treated as
platform revenue. Read `/revenue` from any node, or see
[node-runner-rewards.md](node-runner-rewards.md).

**Is Obsidian a proof-of-work coin?**
No. It is **Proof of Time**. Nobody earns the right to produce a block by
computing more than anyone else; block production is scheduled and gated by
protocol time. The chain still uses SHA-256 and ECDSA — for block ids, state
roots and signatures — because that is how integrity and identity work, not
because computation buys authority. See [proof-of-time.md](proof-of-time.md).

**Can I earn by running a node?**
Yes: 40% of qualifying platform revenue. You register a reward wallet (proving
you control it), stay online, stay in sync, and let other nodes attest that they
saw you. You cannot tell the protocol how well you did — there is no field for
it. See [node-runner-rewards.md](node-runner-rewards.md).

**Is there an exchange inside the product?**
No. There is no native exchange, no order book and no custody. Price discovery
happens on external markets, and the protocol only consumes a price for its own
dollar-denominated features.

**Which networks can I run?**
Mainnet (7777), testnet (7778), staging (7779) and devnet (7780). Each has its own
genesis document and id, ports and address prefix, and a node refuses to mix them.

**Is it production ready?**
Read `docs/IMPLEMENTATION-REPORT.md`. It states plainly which parts are exercised
by automated tests, which are only structurally validated (the Docker recipes) and
where the honest limitations are.
