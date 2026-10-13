# Numbers and long identifiers on screen

This page describes how every Obsidian interface shows token amounts, counts and long identifiers. It covers the main
platform, the Web App, the standalone Wallet web app, the browser extension and the explorer. It is a **display**
convention only: nothing here is read by consensus, a signature, a fee calculation, a balance or an API payload.

## Why amounts used to look wrong

* The protocol holds an amount as an integer number of **seals**; 1 OBS is 10^18 seals (18 decimals, from the protocol's
  own configuration). The node sends an amount in two exact shapes: a seal count as integer text (`balanceSeals`,
  `supplySeals`) and an OBS decimal with 18 places (`totalSupplyObs`, `registrationFeeObs`).
* The protocol's formatter (`formatObs`) prints all 18 places. That is right for a payload and wrong for a person:
  `0.050000000000000000` and `21000000.000000000000000000` came straight from it.
* The platform's page formatter then went the other way and **floored to 8 places**, so a real amount below
  0.00000001 OBS (down to one seal) read as `0`, and the 0.000166666666666666 OBS claim reward read `0.00016666`.
* The Web App rendered some fields raw (`${value} OBS`) and others through a six-place formatter, so the same number
  looked different on different screens.
* The mining schedule table on the platform computed its tiers with floating-point arithmetic. It now uses the
  protocol's own integer schedule.

## The one formatter

`obsidian-core/src/protocol/display.ts` is the source of truth. The Web App ships as plain ES modules with no bundler,
so `obsidian-app-web/public/data.mjs` carries the same functions with the types removed; the Wallet web app and the
extension use that file. Tests hold the copies to one list of cases, `tests/vectors/display.json`, and to each other.

| Rule | Example |
| --- | --- |
| Exact: BigInt on decimal text; a JavaScript `Number` is refused | a number renders as the unavailable mark |
| Trailing zeros and a dangling point removed | `0.050000000000000000` shows `0.05` |
| Whole part grouped with commas, in every locale | `21,000,000 OBS`, `100,000 OBS` |
| Zero | `0 OBS` |
| Never zero for a real amount | one seal shows `0.000000000000000001 OBS` |
| Never scientific notation | `1e-18` is not an amount and shows the unavailable mark |
| Missing or invalid is not zero | the unavailable mark (an em dash), with no unit |
| A display cap truncates down, never rounds up | and a hidden non-zero amount shows `<0.00000001` |

A fixed fee therefore shows at its exact configured precision (`0.05 OBS` for an ONS registration), and a long balance
shows every digit the chain holds.

Amounts a person types are unaffected: they are parsed by `parseObs` / `parseAmount` (digits and one dot, at most 18
places, never rounded) and sent as seals. Display text is never parsed back.

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

`formatObs`, `parseObs`, the transaction encoders, fee and gas calculation, balances, supply, genesis, rewards,
signing, the API payloads and every consensus rule. No node restart or data change is needed to ship this.
