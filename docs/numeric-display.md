# Numbers and long identifiers on screen

This page describes how every Obsidian interface shows token amounts, counts and long identifiers. It covers the main
platform, the Web App, the standalone Wallet web app, the browser extension and the explorer. It is a **display**
convention only: nothing here is read by consensus, a signature, a fee calculation, a balance or an API payload.

## Why amounts used to look wrong

* The protocol holds an amount as an integer number of **seals**; 1 OBS is 10^18 seals (18 decimals, from the protocol's
  own configuration). The node sends an amount in two exact shapes: a seal count as integer text (`balanceSeals`,
  `supplySeals`) and an OBS decimal with 18 places (`totalSupplyObs`, `registrationFeeObs`).
* The protocol's formatter (`formatObs`) prints all 18 places. That is right for a payload and wrong for a person:
  `0.050000000000000000`, `21000000.000000000000000000` and `99999.820626666666666664` came straight from it.
* The platform's page formatter then went the other way and **floored to 8 places**, so a real amount below
  0.00000001 OBS (down to one seal) read as `0`.
* The Web App rendered some fields raw (`${value} OBS`) and others through a six-place formatter, so the same number
  looked different on different screens.
* The mining schedule table on the platform computed its tiers with floating-point arithmetic. It now uses the
  protocol's own integer schedule.

## The one formatter

`obsidian-core/src/protocol/display.ts` is the source of truth. The Web App ships as plain ES modules with no bundler,
so `obsidian-app-web/public/data.mjs` carries the same functions with the types removed; the Wallet web app and the
extension use that file. Tests hold the copies to one list of cases, `tests/vectors/display.json` (whose expected
values were produced by an independent implementation, Python `Decimal` with `ROUND_HALF_UP`), and to each other.

### The policy: at most 6 decimals, rounded to nearest

| Rule | Example |
| --- | --- |
| At most **6 fractional digits** for an ordinary amount (balance, supply, mined, pool, reward, claim, history) | `99999.820626666666666664` shows `99,999.820627` |
| **Rounded to the nearest** displayed unit, ties **away from zero**, in exact integer arithmetic on the full 18-digit value (a carry into the whole part is correct) | `0.0000005` shows `0.000001`; `0.9999995` shows `1`; `99999.9999995` shows `100,000` |
| Trailing zeros and a dangling point removed | `12.340000` shows `12.34`; `100000.000000` shows `100,000` |
| Whole part grouped with commas, in every locale | `21,000,000 OBS`, `100,000 OBS` |
| Zero | `0 OBS` |
| **A real amount below the shown precision is never `0`**: it reads `<0.000001` (a negative one `>-0.000001`) | one seal shows `<0.000001 OBS` |
| Never scientific notation | `1e-18` is not an amount and shows the unavailable mark |
| Missing or invalid is not zero: the unavailable mark (an em dash), with no unit | `null`, `""`, `abc`, a JavaScript `Number` |
| Exact BigInt arithmetic; a JavaScript `Number` is refused | a number renders as the unavailable mark |

Required examples (all are vectors): `99999.820626666666666664` → `99,999.820627`; `100000.000626666666666664` →
`100,000.000627`; `0.000626666666666664` → `0.000627`; `0.000166666666666666` → `0.000167`; `100000` → `100,000`;
`12.340000` → `12.34`; `0` → `0`.

**Text without a point is a seal count.** The node sends OBS decimals with a point and seal counts as integers, so the
shared `displayObs` reads `"100000"` as 100000 seals. Where text is known to be an OBS decimal in whatever shape, use
`displayDecimal` (interface: `obsDecimal`).

### The exact value is never lost

Rounding is for the eyes only. The raw amount in every calculation, payload, API response, signature and stored value
is untouched, and the exact figure is one step away:

* `EXACT_OBS` (`{ maxDecimals: 18 }`) gives every digit the protocol holds, trailing zeros removed.
* Balances, supply, mined and pool figures carry the exact value in a tooltip (`Exact: 99,999.820626666666666664 OBS`),
  which is also the accessible description on a touch screen.
* Anywhere a person **authorises or checks an exact movement of value** the exact view is the display: the send form's
  available balance and fee, the insufficient-balance message, the send review (amount, fee, total, balance after) and
  the wallet's transaction detail. A rounded total next to a signed amount would hide digits that are being committed.

Amounts a person types are unaffected: they are parsed by `parseObs` / `parseAmount` (digits and one dot, at most 18
places, never rounded) and sent as seals. Display text is never parsed back.

### What this policy does not touch

Heights, timestamps, ids, counts, percentages, peer numbers and block spacing are not token amounts. They use
`displayInteger`, the identifier component, or their own unit formatting, and are not given the amount policy.

## The Mining Pool

The **Mining Pool** is consensus state, `state.pool.balance`. A node serves it as `GET /supply` → `poolBalanceObs`
(and as `GET /status` → `pool.balance`, with `lifetimeInflow` and `lifetimeDistributed`). It is a *recycling* pool,
not a pre-funded allocation:

* **In:** gas from payments, names, node registrations, treasury grants and validator bonds, slashed bonds, and the
  treasury share of an ONS fee while no treasury wallet is designated.
* **Out:** a mining claim's reward is paid from the pool **first**; only the shortfall is newly issued (and only that
  raises the mined supply).

So a reading of `0 OBS` is genuine whenever the fees that came in have already been paid to the next claim. It is not a
display error and must not be "fixed" by inventing a figure. Example from the protocol: a 0.2 OBS payment pays 0.00004
OBS gas into the pool; the next claim pays its 0.000166666666666666 OBS reward from that, minting only
0.000126666666666666, and the pool is back to `0`.

What a screen may say is decided by one function, `describeMiningPool` (core `display.ts`, mirrored in `data.mjs`, tested
against `tests/vectors/mining-pool.json`):

| State | When | Shown |
| --- | --- | --- |
| `ok` | the node returned a decimal `poolBalanceObs`, the node is on the chain this interface is for, and its supply check holds | the figure (6 decimals, exact on hover); a genuine `0 OBS` reads `0 OBS` with the reason; lifetime fees in and out when `/status` has them |
| `unavailable` | the field is missing, null, empty, malformed, a number or scientific notation; the node did not say which chain it is on; its own supply invariant is false; `/supply` failed | `—` and the reason. Never `0 OBS` |
| `mismatch` | the node reports another chain id than this interface (mainnet is **7777**, address prefix `obs1…`) | no supply or pool figures; the message names both chain ids |

The pool is never computed from total supply, mined supply, a treasury figure or any wallet. Total supply, mined supply,
the Mining Pool, the node-runner reward pool, the treasury and a wallet's balance and spendable amount are separate
quantities and are shown in separate rows. The platform learns its own chain from `/api/auth/config` (`chainId`,
additive); the Web App from `/app-config.json`.

## Long identifiers

Addresses, transaction ids, block ids and other long values are shortened **for display only**, by one policy:

| Kind | Narrow (phones) | Wide |
| --- | --- | --- |
| Address | first 8, `...`, last 6: `obs1ijdn...slvgsi` | first 14, last 8 |
| Hash / id | first 10, last 8 | first 16, last 10 |

A value that would not get shorter is shown whole. A value a node has already masked for the explorer (it contains an
ellipsis) is shown exactly as it came and offers no copy, because a truncated string is not an identifier.

Every place that shows one uses the same component:

* Platform: `web/src/lib/identifier.ts`. The short form below 720 px, the longer form from 720 px up (CSS, not
  measuring), the whole value on tap or Enter, a Copy button that copies the original, a tooltip with the full value,
  and a screen-reader label with the full value.
* Web App and extension: `public/identifier.mjs`, same behaviour; the toggle is a delegated listener, so it works under
  the extension's no-inline-handler policy.
* Wallet web app: `identifierView` in `lib/views.mjs`, with `data-a` actions only (the wallet ships a strict CSP).
  `maskAddress` there is **not** a display rule: it is the node's own mask, used to decide whether a history row was
  sent or received, and it is unchanged.

Where an identifier is being confirmed rather than skimmed (the receive screen, the send review, a transaction detail
page), it is shown in full, wrapped, with a Copy button.

## Layout

A flex or grid child does not shrink below its content unless it is allowed to (`min-width: 0`), which is how one long
unbroken value used to push a card wider than the phone. The shared styles allow wrapping on every value that can be
long, and keep `overflow-x: hidden` on the body only as a last resort. The Web App's `index.html` is the design file
and stays byte for byte as designed, so its few extra rules are injected as a `<style>` at start-up.

## Adding a screen

Use the shared formatter for every amount and count, the shared component for every long identifier. The guards in
`obsidian-interface/tests/display-guard.test.ts` and `obsidian-app-web/tests/display-parity.test.mjs` fail the build
on a hand-made `toLocaleString`, a raw `${amount} OBS`, or a hand-made `slice(0, n)…` of an identifier.

## What was not changed

`formatObs`, `parseObs`, the transaction encoders, fee and gas calculation, balances, supply, genesis, rewards, mining
claims, signing, the API payloads and every consensus rule. The pool accounting is unchanged (a new core test,
`tests/integration/mining-pool-rpc.test.ts`, pins it end to end). The one additive server change is the `chainId`
field of the interface's `/api/auth/config`.

## Shipping it

No node restart, no genesis, no data or key change. Rebuild and restart only the web processes:
`obsidian-interface@mainnet` (a server change, so it is restarted), `obsidian-app-web@mainnet` and
`obsidian-wallet-web@mainnet`; `obsidian-node@mainnet` is not touched. The commands are in `docs/web-separation.md` and
`docs/ORACLE-VPS-DEPLOYMENT.md`; state lives in `/var/lib/obsidian/` and settings in `/etc/obsidian/`, neither is
changed.
