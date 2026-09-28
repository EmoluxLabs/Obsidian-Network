# Obsidian Circle — land registry

Obsidian Circle maps the planet as a hierarchy and prices land through a protocol
market, not through an admin dashboard:

```
Earth → country → first-level division (state/province/governorate)
      → city → district → street → parcel (1 m²)
```

## 1. Values

| Value | Who sets it | Changes when |
| --- | --- | --- |
| **GLV** — Government Land Value | the protocol, per first-level division | a protocol purchase raises it; a buyback lowers it |
| **ILV** — Individual Land Value | derived per parcel | a parcel's own history (purchase price, official value) |
| **MSP** — Market Sale Price | the owner when listing | the owner may relist freely; listing does not move GLV |

Division GLVs are set at deployment from published economic data (population,
economic activity, infrastructure, tourism) and bounded between **$100 and
$30,000 per m²**. The full country/division list is served by
`GET /land/countries`.

## 2. Buying from the protocol market

* One transaction releases **at most one parcel** and the parcel is **≤ 1 m²**
  (`circle.parcelSquareMetres = 1`).
* The price is the **current GLV** of the division, converted to OBS at the
  protocol oracle price. A transaction whose declared price does not match the
  official conversion is rejected with `ERR_PRICE_MISMATCH` — you cannot buy land
  by quoting yesterday's price or by rounding in your favour.
* The purchase **raises the GLV** by 25 basis points
  (`circle.appreciationStepBps = 25`), capped at $30,000/m².
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
* the GLV **decreases** by 25 basis points, floored at $100/m².

This is the mechanism that makes the protocol a buyer of last resort without
inventing value: what it pays out is what its own valuation says the land is
worth, reduced for the supply it just absorbed.

## 5. Gifting and transfers

`LAND → GIFT` moves a parcel to another address and pays **standard gas** — the
same 0.02% rule as any payment, capped at 0.01 OBS. There is no special "land
transfer tax", and no admin approval step.

## 6. Searching

```bash
curl -s "http://127.0.0.1:8630/land/search?q=Enugu" | jq
curl -s "http://127.0.0.1:8630/land/search?q=6.45,7.51" | jq     # GPS
curl -s "http://127.0.0.1:8630/land/quote/NG-EN" | jq            # price a division
curl -s "http://127.0.0.1:8630/land/parcels?divisionId=NG-EN" | jq
```

Search accepts a country name or code, a state/province, a city, a district, a
street, a landmark or a `lat,lon` pair, and returns both matching divisions and
matching parcels. Every field in a parcel record — GLV at purchase, ILV, MSP,
official value now, area, coordinates, owner — comes from chain state.

## 7. What the protocol deliberately does not do

* It does not revalue parcels when a neighbour sells.
* It does not let a website, an oracle or an operator set a price. A stale oracle
  closes the market (`ERR_ORACLE_UNAVAILABLE`) instead of guessing.
* It does not let anyone buy more than one plot per transaction, which is what
  keeps the "buyer does not retroactively benefit" rule meaningful.
