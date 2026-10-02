# Obsidian Circle — land registry

Obsidian Circle maps the planet as a hierarchy and prices land through a protocol
market, not through an admin dashboard:

```
Earth → country → first-level division (state/province/governorate)
      → parcel (≤ 1 m², addressed by division + level + sub-id + plot index)
```

The geography table that ships with the node contains countries and their
**first-level divisions** (ISO 3166-2) with a weight per division. Finer
granularity below that level is *not* in the shipped table: a parcel carries the
buyer-supplied `level`, `subId`, `plotIndex` and optional GPS coordinates
(`latMicro`/`lonMicro`, stored as signed 1e-6 degrees), and its identity is the
hash of division + level + sub-id + plot index. Search matches country names,
country codes, division names and division ids; it does not resolve streets,
landmarks or coordinates to a division.

## 1. Values

| Value | Who sets it | Changes when |
| --- | --- | --- |
| **GLV** — Government Land Value | the protocol, per first-level division | a protocol purchase raises it; a buyback lowers it |
| **ILV** — Individual Land Value | derived per parcel | a parcel's own history (purchase price, official value) |
| **MSP** — Market Sale Price | the owner when listing | the owner may relist freely; listing does not move GLV |

Division GLVs are set at deployment from published economic data (population,
economic activity, infrastructure, tourism) and bounded between
**0.01 OBS and 5 OBS per m²** (`circle.minGlv` / `circle.maxGlv`). The band is
denominated in OBS and fixed by consensus: no exchange rate takes part, and a
chain that has never seen a price submission values land correctly. `GET /land/countries` lists countries with division counts and
their GLV, and `GET /land/divisions?country=NG` lists a country's divisions with
the GLV each division carries right now.

## 2. Buying from the protocol market

* One transaction releases **at most one parcel** and the parcel is **≤ 1 m²**
  (`circle.parcelSquareMetres = 1`).
* The price is the **current GLV** of the division, already in OBS. A
  transaction whose declared price does not match the official value is
  rejected with `ERR_PRICE_MISMATCH` — you cannot buy land by quoting a stale
  value or by rounding in your favour.
* The purchase **raises the GLV** by 25 basis points
  (`circle.appreciationStepBps = 25`), capped at 5 OBS/m².
* Because the GLV moves between purchases, **a buyer never benefits
  retroactively** from the demand they themselves created: the next buyer pays
  the updated price, and no existing parcel is revalued by a later purchase.

Revenue from protocol sales is routed to the **treasury wallet** by protocol
rule, and the treasury wallet is the wallet that received the genesis allocation.

## 3. Marketplace

* An owner lists a parcel at any MSP (`LAND → LIST`).
* A buyer purchases at the listed MSP (`LAND → BUY_LISTED`); the seller is paid in
  full (minus standard gas) and **the GLV does not change**.
* A listing does not create money and does not change the protocol's valuation of
  the division. Two owners on the same street can ask different prices; the chain
  records the transaction, not an opinion.

## 4. Buyback

`LAND → PROTOCOL_SELL` sells a parcel back to the protocol market:

* the owner is paid the **current GLV** (its official value at that moment), not
  the price they originally paid and not the MSP;
* the GLV **decreases** by 25 basis points, floored at 0.01 OBS/m².

This is the mechanism that makes the protocol a buyer of last resort without
inventing value: what it pays out is what its own valuation says the land is
worth, reduced for the supply it just absorbed.

## 5. Gifting and transfers

`LAND → GIFT` moves a parcel to another address and pays **standard gas** — the
same 0.02% rule as any payment, capped at 0.01 OBS. There is no special "land
transfer tax", and no admin approval step.

## 6. Searching

```bash
curl -s "http://127.0.0.1:8630/land/countries" | jq                     # countries + GLV
curl -s "http://127.0.0.1:8630/land/divisions?country=NG" | jq          # divisions + current GLV
curl -s "http://127.0.0.1:8630/land/search?q=Enugu" | jq                # match divisions
curl -s "http://127.0.0.1:8630/land/quote/NG-EN" | jq                   # price a division
curl -s "http://127.0.0.1:8630/land/parcels?divisionId=NG-EN" | jq      # parcels in a division
```

Search matches a country name or code, a division name or a division id, and
returns matching divisions. Parcels are then read per division. Every field in a
parcel record — GLV, ILV, MSP, area, plot index, owner — comes from chain state,
and the coordinates a buyer supplied are part of the parcel's body on chain.

**Not implemented:** resolving a city, district, street, landmark or `lat,lon`
pair to a division. The shipped geography table stops at first-level divisions,
so a coordinate lookup would have to invent an answer; the interface says what
it matches instead.

## 7. What the protocol deliberately does not do

* It does not revalue parcels when a neighbour sells.
* It does not let a website, an oracle or an operator set a price. A stale oracle
  closes the market (`ERR_ORACLE_UNAVAILABLE`) instead of guessing.
* It does not let anyone buy more than one plot per transaction, which is what
  keeps the "buyer does not retroactively benefit" rule meaningful.
