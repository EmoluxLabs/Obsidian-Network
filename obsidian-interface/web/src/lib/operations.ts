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
 * The protocol has seven transaction types: PAYMENT, ONS, ORACLE, MINING_CLAIM,
 * VALIDATOR, TREASURY and NODE_REGISTRY. ONS is the protocol's only revenue
 * source. Everything the interface can sign is in here; anything absent is
 * absent from the chain too.
 */

import { ObsidianClient } from './client.js';
import { session } from './session.js';
import { Wallet } from './wallet.js';
import { parseObs, formatObs } from '../../core/protocol/amount.js';
import { expectedGas } from '../../core/transactions/helpers.js';
import { TxType } from '../../core/protocol/types.js';
import { OnsOp, ValidatorOp, TreasuryOp } from '../../core/protocol/types.js';
import { encodePaymentBody } from '../../core/transactions/executors/payment.js';
import { encodeMiningBody } from '../../core/transactions/executors/mining.js';
import { encodeOnsBody } from '../../core/transactions/executors/ons.js';
import { PROTOCOL_VERSION } from '../../core/version.js';
import { encodeOracleBody } from '../../core/transactions/executors/oracle.js';
import { encodeValidatorBody } from '../../core/transactions/executors/validator.js';
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

export { expectedGas, formatObs, parseObs };

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
    const amount = parseObs(input.amountObs);
    if (amount <= 0n) throw new Error('amount must be greater than zero');
    const ctx = await context(client, wallet);
    const gas = gasFor(amount);
    const total = BigInt((await client.balance(wallet.address)).balanceSeals);
    if (total < amount + gas) {
      throw new Error(
        `insufficient balance: you have ${formatObs(total)} OBS and this transfer needs ${formatObs(amount + gas)} OBS (including gas)`,
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

  async transferName(client: ObsidianClient, wallet: Wallet, input: { name: string; to: string }): Promise<SubmitResult> {
    const ctx = await context(client, wallet);
    const signed = wallet.sign({
      chainId: ctx.chainId,
      protocolVersion: PROTOCOL_VERSION,
      type: TxType.ONS,
      nonce: ctx.nonce,
      gas: 0n,
      body: encodeOnsBody({ op: OnsOp.TRANSFER, name: input.name, fee: 0n, to: input.to }),
      validUntil: ctx.protocolTime + VALIDITY_SECONDS,
    });
    return submit(client, signed);
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

  // ── Oracle and validators ─────────────────────────────────────────────────

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
   * Register as a validator. The bond is not a variable amount: consensus fixes
   * it at exactly 20,000 OBS, and a registration offering anything else is
   * refused with VALIDATOR_BOND_MISMATCH. The node's parameter table is the
   * source of truth for the number the page shows.
   */
  async registerValidator(
    client: ObsidianClient,
    wallet: Wallet,
    input: { bondObs: string; validatorKey: string; commissionBps?: number },
  ): Promise<SubmitResult> {
    const bond = parseObs(input.bondObs);
    const ctx = await context(client, wallet);
    const signed = wallet.sign({
      chainId: ctx.chainId,
      protocolVersion: PROTOCOL_VERSION,
      type: TxType.VALIDATOR,
      nonce: ctx.nonce,
      gas: gasFor(bond),
      body: encodeValidatorBody({
        op: ValidatorOp.REGISTER,
        bond,
        validatorKey: input.validatorKey,
        commissionBps: input.commissionBps ?? 0,
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
