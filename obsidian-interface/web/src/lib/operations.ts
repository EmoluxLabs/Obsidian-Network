/**
 * Protocol operations, built on top of the node API and the browser wallet.
 *
 * Every operation follows the same shape:
 *   1. ask the node for the authoritative inputs (nonce, protocol time, quote);
 *   2. build the canonical transaction body with the core's encoder;
 *   3. sign it locally with the user's key;
 *   4. submit the signed bytes and wait for inclusion.
 *
 * Step 3 is the only place a private key exists, and it never leaves the tab.
 *
 * The wallet signs PAYMENT, ONS, ORACLE, MINING_CLAIM and TREASURY. NODE_REGISTRY statements are signed by a node's own
 * key on the node, never by this wallet. There are no validator transactions (removed in 1.9.0). ONS is the protocol's only revenue
 * source. Everything the interface can sign is in here; anything absent is
 * absent from the chain too.
 */

import { ObsidianClient } from './client.js';
import { session } from './session.js';
import { Wallet } from './wallet.js';
import { parseObs, formatObs } from '../../core/protocol/amount.js';
import { displaySeals, EXACT_OBS } from '../../core/protocol/display.js';
import { expectedGas } from '../../core/transactions/helpers.js';
import { TxType } from '../../core/protocol/types.js';
import { MarketOp, OnsOp, TreasuryOp } from '../../core/protocol/types.js';
import { encodeMarketBody } from '../../core/transactions/executors/marketplace.js';
import { encodePaymentBody } from '../../core/transactions/executors/payment.js';
import { encodeMiningBody } from '../../core/transactions/executors/mining.js';
import { encodeOnsBody } from '../../core/transactions/executors/ons.js';
import { PROTOCOL_VERSION } from '../../core/version.js';
import { recipientKind, type ResolveDeps } from '../../core/protocol/recipient.js';
import type { MarketOfferView } from './client.js';
import { encodeOracleBody } from '../../core/transactions/executors/oracle.js';
import { encodeTreasuryBody } from '../../core/transactions/executors/treasury.js';

export interface SubmitResult {
  txId: string;
  accepted: boolean;
  simulated: true;
  note: string;
}

const VALIDITY_SECONDS = 600;

async function context(client: ObsidianClient, wallet: Wallet) {
  const [status, balance, network] = await Promise.all([
    client.status(),
    client.balance(wallet.address),
    client.network(),
  ]);
  const chainId = network.network?.chainId ?? status.chainId;
  return {
    chainId,
    protocolTime: status.lastBlockTimestamp,
    nonce: balance.nonce,
    status,
  };
}

async function submit(client: ObsidianClient, signed: Uint8Array): Promise<SubmitResult> {
  const result = await client.submit(signed);
  return {
    txId: String(result.txId ?? ''),
    accepted: true,
    simulated: true,
    note: 'signed locally and accepted into the node mempool; included in the next block',
  };
}

/** One zero-gas ONS ownership operation (offer, accept, cancel, recovery). The signer is whoever the protocol requires. */
async function nameOperation(
  client: ObsidianClient,
  wallet: Wallet,
  op: OnsOp,
  name: string,
  extra: { to?: string; address?: string },
): Promise<SubmitResult> {
  const ctx = await context(client, wallet);
  const signed = wallet.sign({
    chainId: ctx.chainId,
    protocolVersion: PROTOCOL_VERSION,
    type: TxType.ONS,
    nonce: ctx.nonce,
    gas: 0n,
    body: encodeOnsBody({ op, name, fee: 0n, to: extra.to, address: extra.address }),
    validUntil: ctx.protocolTime + VALIDITY_SECONDS,
  });
  return submit(client, signed);
}

/**
 * One Marketplace transaction. Every operation here re-reads the authoritative record from a node immediately before
 * signing and refuses to sign when it no longer matches what the person reviewed. That is a courtesy, not the control:
 * the chain re-checks every one of these conditions itself when the transaction is included, so a stale screen can
 * never authorise anything.
 */
async function marketTransaction(
  client: ObsidianClient,
  wallet: Wallet,
  input: { op: MarketOp; name: string; amount?: bigint; counterparty?: string; offerId?: string; gas?: bigint },
): Promise<SubmitResult> {
  const ctx = await context(client, wallet);
  const signed = wallet.sign({
    chainId: ctx.chainId,
    protocolVersion: PROTOCOL_VERSION,
    type: TxType.ONS_MARKET,
    nonce: ctx.nonce,
    gas: input.gas ?? 0n,
    body: encodeMarketBody({
      op: input.op,
      name: input.name,
      amount: input.amount ?? 0n,
      counterparty: input.counterparty ?? '',
      offerId: input.offerId ?? '',
    }),
    validUntil: ctx.protocolTime + VALIDITY_SECONDS,
  });
  return submit(client, signed);
}

const bareName = (name: string): string => name.trim().toLowerCase().replace(/\.obs$/, '');

/** The wallet's spendable seals (escrow has already left it). Falls back to the balance on a pre-escrow node. */
function spendableOf(balance: { balanceSeals: string; spendableSeals?: string }): bigint {
  return BigInt(balance.spendableSeals ?? balance.balanceSeals);
}

function needFunds(have: bigint, need: bigint, what: string): void {
  if (have < need) {
    throw new Error(
      `insufficient spendable balance: you have ${displaySeals(have, EXACT_OBS)} OBS and ${what} needs ${displaySeals(need, EXACT_OBS)} OBS (including gas). Funds locked in offers are not spendable.`,
    );
  }
}

export { expectedGas, formatObs, parseObs };

/**
 * The three reads the core's recipient resolver needs, from this interface's own client.
 *
 *   lookup    GET /names/<name> — the on-chain ONS record, through the interface gateway
 *   context   /status + /network — the node's chain id, address prefix and head-block time
 *   expected  this interface's configured chain id (/api/auth/config) and the wallet's address prefix
 *
 * The interface refuses to resolve when it cannot say which chain it is for: a node's answer is only
 * believed against an identity that did not come from the node.
 */
export function resolverDeps(client: ObsidianClient, addressHrp: string): ResolveDeps {
  return {
    lookup: (name) => client.name(name),
    context: async () => {
      const [status, network] = await Promise.all([client.status(), client.network()]);
      return {
        chainId: Number(network.network?.chainId ?? status.chainId),
        addressHrp: String(network.network?.addressHrp ?? ''),
        protocolTime: Number(status.lastBlockTimestamp),
      };
    },
    expected: async () => {
      const config = await session.config();
      if (!Number.isSafeInteger(config.chainId)) throw new Error('this interface is not tied to a chain, so it cannot check an ONS answer');
      return { chainId: config.chainId as number, addressHrp };
    },
  };
}

/** Protocol gas for a transfer of `amount` seals. */
export function gasFor(amount: bigint): bigint {
  return expectedGas(amount);
}

export const operations = {
  /**
   * Claim a mining reward. The browser clock is never used: the node supplies protocol time.
   *
   * Since protocol 1.7.0 the chain refuses a claim that does not carry a certificate from the mining gate, so the
   * account platform is asked for one (it issues it only to a signed-in, second-factor-confirmed account for its own
   * linked wallet) before the claim is signed. `requestCertificate` is a seam for tests.
   */
  async claim(
    client: ObsidianClient,
    wallet: Wallet,
    requestCertificate: (address: string, claimId: string) => Promise<{ issuer: string; issuedAt: number; signature: string }> = (address, claimId) =>
      session.miningCertificate(address, claimId),
  ): Promise<SubmitResult & { rewardObs: string }> {
    const mining = await client.miningStatus(wallet.address);
    if (!mining.eligible) throw new Error(mining.reason ? `not eligible: ${mining.reason}` : 'not eligible yet');
    const gate = await requestCertificate(wallet.address, mining.nextClaimId);
    const ctx = await context(client, wallet);
    const signed = wallet.sign({
      chainId: ctx.chainId,
      protocolVersion: PROTOCOL_VERSION,
      type: TxType.MINING_CLAIM,
      nonce: ctx.nonce,
      gas: 0n,
      body: encodeMiningBody({ claimId: mining.nextClaimId, claimSequence: mining.nextClaimSequence, gate }),
      validUntil: ctx.protocolTime + VALIDITY_SECONDS,
    });
    const result = await submit(client, signed);
    return { ...result, rewardObs: mining.rewardPerClaimObs };
  },

  async send(
    client: ObsidianClient,
    wallet: Wallet,
    input: { to: string; amountObs: string; memo?: string },
  ): Promise<SubmitResult> {
    // A PAYMENT carries an address and nothing else. A `.obs` name has to be resolved (and confirmed by the person)
    // BEFORE this is called; it is never written into the transaction.
    if (recipientKind(input.to) === 'name') {
      throw new Error('a .obs name must be resolved to an address before it can be paid');
    }
    const amount = parseObs(input.amountObs);
    if (amount <= 0n) throw new Error('amount must be greater than zero');
    const ctx = await context(client, wallet);
    const gas = gasFor(amount);
    const total = BigInt((await client.balance(wallet.address)).balanceSeals);
    if (total < amount + gas) {
      throw new Error(
        `insufficient balance: you have ${displaySeals(total, EXACT_OBS)} OBS and this transfer needs ${displaySeals(amount + gas, EXACT_OBS)} OBS (including gas)`,
      );
    }
    const signed = wallet.sign({
      chainId: ctx.chainId,
      protocolVersion: PROTOCOL_VERSION,
      type: TxType.PAYMENT,
      nonce: ctx.nonce,
      gas,
      body: encodePaymentBody({ to: input.to, amount, memo: input.memo }),
      validUntil: ctx.protocolTime + VALIDITY_SECONDS,
    });
    return submit(client, signed);
  },

  // ── ONS ───────────────────────────────────────────────────────────────────

  /**
   * Register a .obs name. The registration fee is the protocol's only revenue
   * source: 90% goes to the node-runner pool and 10% to the treasury, split
   * inside the state transition. The fee is fixed by consensus, so the wallet
   * pays exactly what the node's parameter table says.
   */
  async registerName(client: ObsidianClient, wallet: Wallet, input: { name: string; feeObs: string }): Promise<SubmitResult> {
    const fee = parseObs(input.feeObs);
    const ctx = await context(client, wallet);
    const signed = wallet.sign({
      chainId: ctx.chainId,
      protocolVersion: PROTOCOL_VERSION,
      type: TxType.ONS,
      nonce: ctx.nonce,
      gas: gasFor(fee),
      body: encodeOnsBody({ op: OnsOp.REGISTER, name: input.name, fee }),
      validUntil: ctx.protocolTime + VALIDITY_SECONDS,
    });
    return submit(client, signed);
  },

  async renewName(client: ObsidianClient, wallet: Wallet, input: { name: string; feeObs: string }): Promise<SubmitResult> {
    const fee = parseObs(input.feeObs);
    const ctx = await context(client, wallet);
    const signed = wallet.sign({
      chainId: ctx.chainId,
      protocolVersion: PROTOCOL_VERSION,
      type: TxType.ONS,
      nonce: ctx.nonce,
      gas: gasFor(fee),
      body: encodeOnsBody({ op: OnsOp.RENEW, name: input.name, fee }),
      validUntil: ctx.protocolTime + VALIDITY_SECONDS,
    });
    return submit(client, signed);
  },

  /**
   * Offer a name to another wallet (protocol 1.9.0). Nothing changes hands: the name stays with its owner until the
   * recipient sends ACCEPT_TRANSFER, and the offer lapses by itself after seven days.
   */
  async offerNameTransfer(client: ObsidianClient, wallet: Wallet, input: { name: string; to: string }): Promise<SubmitResult> {
    return nameOperation(client, wallet, OnsOp.TRANSFER, input.name, { to: input.to });
  },

  /** Take a name that was offered to this wallet. Only the wallet named in the offer can do this. */
  async acceptNameTransfer(client: ObsidianClient, wallet: Wallet, input: { name: string }): Promise<SubmitResult> {
    return nameOperation(client, wallet, OnsOp.ACCEPT_TRANSFER, input.name, {});
  },

  /** Withdraw an open offer (owner only). */
  async cancelNameTransfer(client: ObsidianClient, wallet: Wallet, input: { name: string }): Promise<SubmitResult> {
    return nameOperation(client, wallet, OnsOp.CANCEL_TRANSFER, input.name, {});
  },

  /** Set the recovery address of a name, or clear it with an empty address (owner only). */
  async setNameRecovery(client: ObsidianClient, wallet: Wallet, input: { name: string; address: string }): Promise<SubmitResult> {
    return nameOperation(client, wallet, OnsOp.SET_RECOVERY, input.name, { address: input.address });
  },

  /** Signed by the RECOVERY address: propose a new owner. It takes effect only after the recovery delay. */
  async startNameRecovery(client: ObsidianClient, wallet: Wallet, input: { name: string; newOwner: string }): Promise<SubmitResult> {
    return nameOperation(client, wallet, OnsOp.START_RECOVERY, input.name, { address: input.newOwner });
  },

  /** The current owner cancels a recovery in flight. */
  async cancelNameRecovery(client: ObsidianClient, wallet: Wallet, input: { name: string }): Promise<SubmitResult> {
    return nameOperation(client, wallet, OnsOp.CANCEL_RECOVERY, input.name, {});
  },

  /** Complete a recovery once the delay has passed (recovery address or the new owner). */
  async finalizeNameRecovery(client: ObsidianClient, wallet: Wallet, input: { name: string }): Promise<SubmitResult> {
    return nameOperation(client, wallet, OnsOp.FINALIZE_RECOVERY, input.name, {});
  },

  async updateNameAddress(
    client: ObsidianClient,
    wallet: Wallet,
    input: { name: string; address: string },
  ): Promise<SubmitResult> {
    const ctx = await context(client, wallet);
    const signed = wallet.sign({
      chainId: ctx.chainId,
      protocolVersion: PROTOCOL_VERSION,
      type: TxType.ONS,
      nonce: ctx.nonce,
      gas: 0n,
      body: encodeOnsBody({ op: OnsOp.UPDATE_ADDRESS, name: input.name, address: input.address, fee: 0n }),
      validUntil: ctx.protocolTime + VALIDITY_SECONDS,
    });
    return submit(client, signed);
  },

  // ── ONS Marketplace (protocol 2.0.0) ─────────────────────────────────────

  /** List a name you own at a fixed price. The name is locked until the listing is removed or the name is sold. */
  async listName(client: ObsidianClient, wallet: Wallet, input: { name: string; priceObs: string }): Promise<SubmitResult> {
    const name = bareName(input.name);
    const price = parseObs(input.priceObs);
    if (price <= 0n) throw new Error('the price must be greater than zero');
    const status = await client.marketName(name);
    if (status.owner !== wallet.address) throw new Error('only the owner can list a name');
    if (status.status === 'LISTED') throw new Error('this name is already listed: change its price or remove the listing first');
    if (status.status !== 'OWNED') throw new Error('this name is not active');
    return marketTransaction(client, wallet, { op: MarketOp.LIST, name, amount: price });
  },

  async updateListingPrice(client: ObsidianClient, wallet: Wallet, input: { name: string; priceObs: string }): Promise<SubmitResult> {
    const name = bareName(input.name);
    const price = parseObs(input.priceObs);
    if (price <= 0n) throw new Error('the price must be greater than zero');
    const status = await client.marketName(name);
    if (status.owner !== wallet.address || status.status !== 'LISTED') throw new Error('you do not have an active listing for this name');
    return marketTransaction(client, wallet, { op: MarketOp.UPDATE_PRICE, name, amount: price });
  },

  /** Remove your listing: the name is usable again. */
  async removeListing(client: ObsidianClient, wallet: Wallet, input: { name: string }): Promise<SubmitResult> {
    const name = bareName(input.name);
    const status = await client.marketName(name);
    if (status.owner !== wallet.address || !status.locked) throw new Error('you do not have an active listing for this name');
    return marketTransaction(client, wallet, { op: MarketOp.DELIST, name });
  },

  /**
   * Buy a listed name at the price and from the seller the person reviewed. The price and the seller are written into
   * the transaction, so a listing that was re-priced or sold since the review makes the chain reject it.
   */
  async buyName(
    client: ObsidianClient,
    wallet: Wallet,
    input: { name: string; reviewedPriceSeals: string; reviewedSeller: string },
  ): Promise<SubmitResult> {
    const name = bareName(input.name);
    const status = await client.marketName(name);
    const listing = status.listing;
    if (status.status !== 'LISTED' || !listing) throw new Error('this name is no longer listed — it may have been sold or the listing removed');
    if (listing.seller === wallet.address) throw new Error('you cannot buy your own listing');
    if (listing.priceSeals !== input.reviewedPriceSeals || listing.seller !== input.reviewedSeller) {
      throw new Error('the listing changed since you reviewed it. Review the new price and seller, then try again');
    }
    const price = BigInt(listing.priceSeals);
    const gas = gasFor(price);
    needFunds(spendableOf(await client.balance(wallet.address)), price + gas, 'this purchase');
    return marketTransaction(client, wallet, { op: MarketOp.BUY, name, amount: price, counterparty: listing.seller, gas });
  },

  /** Offer OBS for an owned, unlisted name. The amount is locked in escrow immediately; gas is charged on top. */
  async makeOffer(client: ObsidianClient, wallet: Wallet, input: { name: string; amountObs: string }): Promise<SubmitResult> {
    const name = bareName(input.name);
    const amount = parseObs(input.amountObs);
    if (amount <= 0n) throw new Error('the offer must be greater than zero');
    const status = await client.marketName(name);
    if (status.status === 'LISTED') throw new Error('this name is listed for sale: buy it at the listed price instead');
    if (status.status !== 'OWNED' || !status.owner) throw new Error('only an owned, active name can receive an offer');
    if (status.owner === wallet.address) throw new Error('you own this name');
    const gas = gasFor(amount);
    needFunds(spendableOf(await client.balance(wallet.address)), amount + gas, 'this offer');
    return marketTransaction(client, wallet, { op: MarketOp.OFFER, name, amount, counterparty: status.owner, gas });
  },

  /** Owner: accept a pending offer. The name moves to the maker and the escrow is paid to you, atomically. */
  async acceptOffer(client: ObsidianClient, wallet: Wallet, input: { offer: Pick<MarketOfferView, 'id' | 'name' | 'amountSeals'> }): Promise<SubmitResult> {
    const fresh = (await client.marketOffer(input.offer.id)).offer;
    if (fresh.status !== 'PENDING') throw new Error(`this offer is already ${fresh.status.toLowerCase()}`);
    if (fresh.currentOwner !== wallet.address) throw new Error('only the current owner can accept this offer');
    return marketTransaction(client, wallet, {
      op: MarketOp.ACCEPT_OFFER,
      name: bareName(fresh.name),
      amount: BigInt(fresh.amountSeals),
      offerId: fresh.id,
    });
  },

  /** Owner: decline a pending offer; the escrow returns to the maker. */
  async declineOffer(client: ObsidianClient, wallet: Wallet, input: { offer: Pick<MarketOfferView, 'id' | 'name'> }): Promise<SubmitResult> {
    const fresh = (await client.marketOffer(input.offer.id)).offer;
    if (fresh.status !== 'PENDING') throw new Error(`this offer is already ${fresh.status.toLowerCase()}`);
    return marketTransaction(client, wallet, { op: MarketOp.DECLINE_OFFER, name: bareName(fresh.name), offerId: fresh.id });
  },

  /** Maker: cancel your own pending offer; the escrow returns to you. */
  async cancelOffer(client: ObsidianClient, wallet: Wallet, input: { offer: Pick<MarketOfferView, 'id' | 'name'> }): Promise<SubmitResult> {
    const fresh = (await client.marketOffer(input.offer.id)).offer;
    if (fresh.status !== 'PENDING') throw new Error(`this offer is already ${fresh.status.toLowerCase()}`);
    if (fresh.maker !== wallet.address) throw new Error('only the maker can cancel an offer');
    return marketTransaction(client, wallet, { op: MarketOp.CANCEL_OFFER, name: bareName(fresh.name), offerId: fresh.id });
  },

  // ── Oracle ─────────────────────────────────────────────────

  async publishPrice(
    client: ObsidianClient,
    wallet: Wallet,
    input: { source: string; priceUsd: number; observedAt?: number },
  ): Promise<SubmitResult> {
    const status = await client.status();
    const observedAt = input.observedAt ?? status.lastBlockTimestamp;
    const ctx = await context(client, wallet);
    const signed = wallet.sign({
      chainId: ctx.chainId,
      protocolVersion: PROTOCOL_VERSION,
      type: TxType.ORACLE,
      nonce: ctx.nonce,
      gas: 0n,
      body: encodeOracleBody({
        observations: [
          { source: input.source, priceUsdMicro: BigInt(Math.round(input.priceUsd * 1_000_000)), observedAt },
        ],
        submissionId: randomHex(16),
      }),
      validUntil: ctx.protocolTime + VALIDITY_SECONDS,
    });
    return submit(client, signed);
  },

  /**
   * Spend from the treasury. Only the designated treasury key can sign this,
   * and it pays out of the balance the 10% ONS treasury share built up — it
   * cannot create revenue, mint, or reach user funds.
   */
  async payRevenue(
    client: ObsidianClient,
    wallet: Wallet,
    input: { amountObs: string; purpose: string },
  ): Promise<SubmitResult> {
    const amount = parseObs(input.amountObs);
    const ctx = await context(client, wallet);
    const signed = wallet.sign({
      chainId: ctx.chainId,
      protocolVersion: PROTOCOL_VERSION,
      type: TxType.TREASURY,
      nonce: ctx.nonce,
      gas: gasFor(amount),
      body: encodeTreasuryBody({ op: TreasuryOp.GRANT, amount, purpose: input.purpose }),
      validUntil: ctx.protocolTime + VALIDITY_SECONDS,
    });
    return submit(client, signed);
  },
};

/**
 * Wait for the chain to confirm a Marketplace action by reading authoritative state, not by trusting that a
 * submission was accepted into a mempool. Resolves true when `confirmed()` holds, false after about a minute
 * (the transaction may still be pending, or the chain refused it: the caller says which it can see).
 */
export async function awaitConfirmation(
  client: ObsidianClient,
  confirmed: () => Promise<boolean>,
  options: { pollMs?: number; tries?: number } = {},
): Promise<boolean> {
  const pollMs = options.pollMs ?? 1_500;
  const tries = options.tries ?? 40;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (await confirmed().catch(() => false)) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  void client;
  return false;
}

export function randomHex(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let out = '';
  for (const byte of value) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * Wait until the chain has moved on by `count` blocks, so a transaction signed a moment ago has been
 * included and a page that re-reads the chain shows it. Gives up quietly after about 45 seconds: the
 * page then simply shows what the chain has.
 */
export async function waitForBlocks(client: ObsidianClient, count: number, options: { pollMs?: number; tries?: number } = {}): Promise<void> {
  const pollMs = options.pollMs ?? 1_500;
  const tries = options.tries ?? 30;
  const start = (await client.status().catch(() => undefined))?.height;
  if (start === undefined) return;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const height = (await client.status().catch(() => undefined))?.height;
    if (height !== undefined && height >= start + count) return;
  }
}
