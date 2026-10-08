# Obsidian Mobile blueprint audit

Source: `EmoluxLabs/Obsidian-Mobile-App-HTML`, single file `obsidian-app.html`
(253,672 bytes, one `<style>` and one `<script>`).

## Screens the blueprint defines

`const V = { splash, landing, signup, signin, home, mine, wallet, explorer, ons,
node, api, menu }` — **twelve**, driven by a `cur` variable and a `go(s)`
navigation function. `render()` redirects to `signin` when `cur` is one of
`home | mine | wallet | menu` and no session exists.

## Design tokens, verbatim

`--bg:#F6F7F9 --ob:#0B0D10 --tx:#111318 --mu:#68707C --go:#C8A85A --gd:#7A6126
--bd:#E4E7EB --ok:#1F7A55 --er:#A12626`

All match `ObsidianTokens.kt` except the error colour: the blueprint uses
`#A12626`, the app currently uses `#B3261E`. Frame is `max-width:430px`,
`padding:0 20px 100px`, card radius 20, button height 56 radius 16, input height
56 radius 14.

## Splash, exactly

240px ring; track `#E4E7EB` at 5px; gold `#C8A85A` arc with
`stroke-dasharray="150 554"` (150 of 704 circumference units), rotated −90°;
`animation: sp 2.4s linear infinite`; 150px logo centred inside; wordmark
"OBSIDIAN NETWORK" at `.24em` tracking fading in via `fd .8s .6s both`.

## What the blueprint fakes, and must not be ported

The file labels its own placeholders. These are design, not behaviour:

| Blueprint code | What it actually is |
| --- | --- |
| `/* DEMO ONLY: replace VALID with a server-side invite check */ const VALID=['OBS-FOUN-D001','OBS-TIME-2026','OBS-BETA-0001']` | A hardcoded local array. There is no invitation system in the protocol, so the field can be shown but must never report a code as verified. |
| `/* DEMO: password is not verified; do real auth on a server */` | Sign-in checks only that a localStorage entry exists. No authentication occurs. |
| `claim(){ … const a=RATE*4; S.bal+=a; … }` with `RATE=0.25` | Fabricated mining rewards added to a localStorage balance. Forbidden outright. |
| `startM(){S.mine=Date.now()}` with `SESS=14400` | A fake four-hour mining session timer. The protocol has no such session. |
| `TAKEN=['time.obs','satoshi.obs','block.obs']`, `FEE=0.001`, `PRICE=25` | Invented ONS availability, fee and price. Real values come from the node. |

The mandate is explicit that placeholder values must not become blockchain facts,
and that a feature which is visually present but unsupported keeps its visual
form while communicating its real status. So the rebuild keeps all twelve layouts
and none of these five behaviours.
