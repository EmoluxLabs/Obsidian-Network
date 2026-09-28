# OBS Social

Posts, comments, follows, direct messages, tips and business pages — stored as
chain state, with no company in the middle and no algorithm deciding who sees
what.

## 1. Accounts

An OBS Social account is identified by an **opaque application id**: 8–64
characters of letters, digits, `_` and `-`. It is deliberately *not* your wallet
address, not your email and not your Google subject id. The protocol rejects
anything else (`accountId must be 8-64 characters…`), which is what stops a
client from quietly publishing a wallet address as a social identity.

Publishing a profile is the first transaction; the protocol requires it before
you can post, comment, follow, tip or open a business page. This prevents
anonymous spam accounts from existing without ever paying for storage: the chain
remembers each profile forever, and gas is the price of that permanence.

## 2. Posts, comments and follows

| Action | Transaction | Notes |
| --- | --- | --- |
| Set profile | `SOCIAL → SET_PROFILE` | handle, display name, bio |
| Post | `SOCIAL → POST` | up to 8 KiB of UTF-8 content |
| Comment | `SOCIAL → POST` with `parentPostId` | up to 2 KiB |
| Delete | `SOCIAL → DELETE_POST` | author only; the deletion is itself recorded |
| Follow / unfollow | `SOCIAL → FOLLOW` / `UNFOLLOW` | a directed edge in state |

Content is content-addressed by the transaction that carries it; the indexer
builds the feed from blocks, and `GET /social/feed` returns posts with their
timestamps. A feed cache in a frontend is a *cache*: the source is the chain, and
the node says so in its response (`"onChain": true`).

## 3. Tips

`SOCIAL → TIP` moves OBS from the tipper to the creator, attached to a post or a
profile. **100% of the tip goes to the creator** — the protocol takes no cut, the
interface takes no cut, and the only deduction is the ordinary gas that returns to
the Mining Pool. A tip is a payment you can verify like any other.

## 4. Business pages and the 70/30 split

A business page costs the protocol's **$50 equivalent** in OBS
(`social.businessPagePriceUsd = 50.00`, converted at the oracle median) and that
payment goes to the **treasury**. On monetised revenue, the protocol split is:

* **70% to the creator** (`creatorShareBps = 7000`),
* **30% to the network — the treasury** (`networkShareBps = 3000`).

Monetisation itself is gated by the protocol (`monetisationMinFollowers = 10,000`,
`monetisationMinMonthlyViews = 100,000`). Those gates are state, not a manual
review queue.

## 5. Direct messages

DMs are **end-to-end encrypted in the browser**: the interface derives a shared
secret between the two accounts and encrypts locally, so the ciphertext is what
would be carried in a message transaction and the interface server never sees a
plaintext DM. The protocol does not try to hide *that* a message exists — the
chain records the transaction — but the content is not readable by nodes, by this
website, or by whoever operates the CDN in front of it.

## 6. Verification, views and rate limits

Verification (`SOCIAL → REQUEST_VERIFICATION`) and view attestation
(`SOCIAL → ATTEST_VIEWS`) are protocol transactions with their own rules and rate
limits: a client cannot inflate a view count by claiming numbers in a browser.
Attestations are bounded per account and per window, and the protocol records who
attested what.

## 7. Costs, honestly

Every one of these actions is a transaction and every transaction costs gas. Gas
on a post is small but non-zero, and it is **not refundable** — the network stores
your post in a block that every node will keep. If you want free posting with
censorship risk, use any Web 2 service; if you want permanence, this is the price.
