# Contributing

## The one rule

**Consensus is the source of truth, and the arrow never points backwards:**

```
consensus → node state → verified chain data → APIs and indexes → frontend cache
```

A change that lets a website, a database, a Cloudflare worker, an environment
variable or an administrator decide something the chain should decide will be
rejected no matter how well written it is. If you find yourself adding a
configuration flag that changes economics, stop — that is a consensus parameter
and it belongs in `obsidian-core/src/protocol/params.ts` behind a version bump.

## Getting set up

Node.js ≥ 20.10.

```bash
git clone https://github.com/EmoluxLabs/Obsidian-Network.git
cd Obsidian-Network

cd obsidian-core && npm ci && npm run build && npm test        # 251 tests
cd ../obsidian-interface && npm ci && npm run build && npm test # 191 tests
cd .. && node --test cloudflare/test/worker.test.mjs            # 9 tests
node --test tests/e2e/cluster.test.mjs                          # 13 tests
node --test tests/scripts/release-signing.test.mjs              # 8 tests
node scripts/check-invariants.mjs                               # 55 invariants
```

All of that must pass before you open a pull request; CI runs exactly these.

Run a local chain to poke at:

```bash
cd obsidian-core
node dist/index.js start --network devnet --data-dir /tmp/obs --rpc-port 8630
curl -s localhost:8630/status
```

Devnet produces blocks every 5 seconds and is disposable — delete the data
directory and start again whenever you like.

## Before you change consensus

Anything that alters block validity, state transitions, encoding, hashing or
economic parameters changes the params hash, which means **every node must
upgrade together or the network forks.** Such a change needs:

1. A clear statement of what breaks and why the break is worth it.
2. A protocol version bump in `params.ts`.
3. Tests that fail before the change and pass after it.
4. Documentation updated in the same pull request — `docs/protocol.md`,
   `docs/proof-of-time.md` or whichever describes the rule.
5. An update to `scripts/check-invariants.mjs` if a guarded value moves, with
   the change called out explicitly in the PR description. Silently editing an
   invariant to make a test pass is the one thing that will get a PR closed
   without discussion.

Note that the `e2e/cluster.test.mjs` suite binds ports 39630–39635 and cannot
run concurrently with itself.

## Style, as practised here

* **TypeScript, strict.** No `any` in consensus paths.
* **No JSON in any hashing or signing path.** Use the canonical encoder in
  `src/protocol/encoding.ts`. JSON key order is not a consensus guarantee.
* **Domain-separate every hash.** See `src/protocol/domains.ts`. A signature
  valid in two contexts is a vulnerability.
* **Amounts are `bigint` seals** (1 OBS = 10^18). Never floats. Never `number`
  for money.
* **Comments explain why, not what.** If a line is subtle — and consensus code
  often is — say what goes wrong if it is written the obvious way. Several of
  the comments in this codebase exist because the obvious version was written
  first and broke something.
* **Tests assert behaviour, not implementation.** A test that only passes
  because of how the code is currently structured is a liability.

## Pull requests

Keep them focused. Explain what changes and what the consequence is for someone
already running a node. If it touches consensus, say so in the first line.

New behaviour needs a test. Bug fixes need a test that fails without the fix —
if you cannot write one, explain why in the PR, because that is usually a sign
the bug is not yet understood.

Do not commit: private keys, keystores, `.pass` files, real wallet addresses you
control, `node_modules`, or build output other than the release archives that
`scripts/package-releases.sh` produces.

## Reporting security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## Licence

Contributions are accepted under the Apache License 2.0, the same licence as the
project.
