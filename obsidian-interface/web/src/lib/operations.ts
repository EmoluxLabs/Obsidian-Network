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
 */

import { ObsidianClient } from './client.js';
import { Wallet } from './wallet.js';
import { parseObs, formatObs } from '../../core/protocol/amount.js';
import { expectedGas } from '../../core/transactions/helpers.js';
import { TxType } from '../../core/protocol/types.js';
import { OnsOp, CapsuleOp, LandOp, SocialOp, ValidatorOp, TreasuryOp } from '../../core/protocol/types.js';
import { encodePaymentBody } from '../../core/transactions/executors/payment.js';
import { encodeMiningBody } from '../../core/transactions/executors/mining.js';
import { encodeOnsBody } from '../../core/transactions/executors/ons.js';
import { encodeCapsuleBody } from '../../core/transactions/executors/capsule.js';
import { encodeLandBody } from '../../core/transactions/executors/land.js';
import { encodeSocialBody } from '../../core/transactions/executors/social.js';
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
  /** Claim a mining reward. The browser clock is never used: the node supplies protocol time. */
  async claim(client: ObsidianClient, wallet: Wallet): Promise<SubmitResult & { rewardObs: string }> {
    const mining = await client.miningStatus(wallet.address);
    if (!mining.eligible) throw new Error(mining.reason ? `not eligible: ${mining.reason}` : 'not eligible yet');
    const ctx = await context(client, wallet);
    const signed = wallet.sign({
      chainId: ctx.chainId,
      protocolVersion: PROTOCOL_VERSION,
      type: TxType.MINING_CLAIM,
      nonce: ctx.nonce,
      gas: 0n,
      body: encodeMiningBody({ claimId: mining.nextClaimId, claimSequence: mining.nextClaimSequence }),
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

  // ── Capsules ──────────────────────────────────────────────────────────────

  async createCapsule(
    client: ObsidianClient,
    wallet: Wallet,
    input: { contentCommitment: string; contentNonce: string; unlockAt: number; commitmentObs: string; contentBytes: number },
  ): Promise<SubmitResult> {
    const commitment = parseObs(input.commitmentObs);
    const unlockAt = Math.round(input.unlockAt);
    const ctx = await context(client, wallet);
    const signed = wallet.sign({
      chainId: ctx.chainId,
      protocolVersion: PROTOCOL_VERSION,
      type: TxType.CAPSULE,
      nonce: ctx.nonce,
      gas: gasFor(commitment),
      body: encodeCapsuleBody({
        op: CapsuleOp.CREATE,
        capsuleId: '',
        contentCommitment: input.contentCommitment,
        contentNonce: input.contentNonce,
        unlockAt,
        commitment,
        contentBytes: input.contentBytes,
      }),
      validUntil: ctx.protocolTime + VALIDITY_SECONDS,
    });
    return submit(client, signed);
  },

  async previewCapsule(
    client: ObsidianClient,
    wallet: Wallet,
    input: { capsuleId: string; paymentObs: string; previewChunk: string },
  ): Promise<SubmitResult> {
    const payment = parseObs(input.paymentObs);
    const ctx = await context(client, wallet);
    const capsule = (await client.capsule(input.capsuleId)) as {
      contentCommitment?: string;
      contentNonce?: string;
      unlockAt?: number;
      owner?: string;
    };
    const signed = wallet.sign({
      chainId: ctx.chainId,
      protocolVersion: PROTOCOL_VERSION,
      type: TxType.CAPSULE,
      nonce: ctx.nonce,
      gas: gasFor(payment),
      body: encodeCapsuleBody({
        op: CapsuleOp.PREVIEW,
        capsuleId: input.capsuleId,
        contentCommitment: capsule.contentCommitment ?? '',
        contentNonce: capsule.contentNonce ?? '',
        unlockAt: capsule.unlockAt ?? 0,
        payment,
        previewChunk: input.previewChunk,
        contentBytes: 0,
      }),
      validUntil: ctx.protocolTime + VALIDITY_SECONDS,
    });
    return submit(client, signed);
  },

  // ── Obsidian Circle (land) ────────────────────────────────────────────────

  async buyParcel(
    client: ObsidianClient,
    wallet: Wallet,
    input: { divisionId: string; countryCode: string; level?: number; subId?: string; plotIndex?: bigint; latMicro?: number; lonMicro?: number },
  ): Promise<SubmitResult> {
    const quote = await client.landQuote(input.divisionId);
    const price = parseObs(quote.priceObs ?? '0');
    if (price <= 0n) throw new Error('this division has no protocol price yet (no protocol sale has set a GLV for it)');
    const ctx = await context(client, wallet);
    const signed = wallet.sign({
      chainId: ctx.chainId,
      protocolVersion: PROTOCOL_VERSION,
      type: TxType.LAND,
      nonce: ctx.nonce,
      gas: gasFor(price),
      body: encodeLandBody({
        op: LandOp.PROTOCOL_BUY,
        divisionId: input.divisionId,
        countryCode: input.countryCode,
        level: input.level ?? 1,
        subId: input.subId ?? '',
        plotIndex: input.plotIndex ?? 0n,
        latMicro: input.latMicro,
        lonMicro: input.lonMicro,
        price,
      }),
      validUntil: ctx.protocolTime + VALIDITY_SECONDS,
    });
    return submit(client, signed);
  },

  async listParcel(
    client: ObsidianClient,
    wallet: Wallet,
    input: { divisionId: string; countryCode: string; parcelId: string; mspObs: string },
  ): Promise<SubmitResult> {
    const price = parseObs(input.mspObs);
    const ctx = await context(client, wallet);
    const signed = wallet.sign({
      chainId: ctx.chainId,
      protocolVersion: PROTOCOL_VERSION,
      type: TxType.LAND,
      nonce: ctx.nonce,
      gas: 0n,
      body: encodeLandBody({
        op: LandOp.LIST,
        divisionId: input.divisionId,
        countryCode: input.countryCode,
        level: 1,
        subId: '',
        plotIndex: 0n,
        price,
        to: input.parcelId,
      }),
      validUntil: ctx.protocolTime + VALIDITY_SECONDS,
    });
    return submit(client, signed);
  },

  async buyListedParcel(
    client: ObsidianClient,
    wallet: Wallet,
    input: { divisionId: string; countryCode: string; mspObs: string },
  ): Promise<SubmitResult> {
    const price = parseObs(input.mspObs);
    const ctx = await context(client, wallet);
    const signed = wallet.sign({
      chainId: ctx.chainId,
      protocolVersion: PROTOCOL_VERSION,
      type: TxType.LAND,
      nonce: ctx.nonce,
      gas: gasFor(price),
      body: encodeLandBody({
        op: LandOp.BUY_LISTED,
        divisionId: input.divisionId,
        countryCode: input.countryCode,
        level: 1,
        subId: '',
        plotIndex: 0n,
        price,
      }),
      validUntil: ctx.protocolTime + VALIDITY_SECONDS,
    });
    return submit(client, signed);
  },

  async sellParcelToProtocol(
    client: ObsidianClient,
    wallet: Wallet,
    input: { divisionId: string; countryCode: string },
  ): Promise<SubmitResult> {
    const ctx = await context(client, wallet);
    const signed = wallet.sign({
      chainId: ctx.chainId,
      protocolVersion: PROTOCOL_VERSION,
      type: TxType.LAND,
      nonce: ctx.nonce,
      gas: 0n,
      body: encodeLandBody({
        op: LandOp.PROTOCOL_SELL,
        divisionId: input.divisionId,
        countryCode: input.countryCode,
        level: 1,
        subId: '',
        plotIndex: 0n,
      }),
      validUntil: ctx.protocolTime + VALIDITY_SECONDS,
    });
    return submit(client, signed);
  },

  async giftParcel(
    client: ObsidianClient,
    wallet: Wallet,
    input: { divisionId: string; countryCode: string; to: string; officialValueObs: string },
  ): Promise<SubmitResult> {
    const officialValue = parseObs(input.officialValueObs);
    const ctx = await context(client, wallet);
    const signed = wallet.sign({
      chainId: ctx.chainId,
      protocolVersion: PROTOCOL_VERSION,
      type: TxType.LAND,
      nonce: ctx.nonce,
      gas: gasFor(officialValue),
      body: encodeLandBody({
        op: LandOp.GIFT,
        divisionId: input.divisionId,
        countryCode: input.countryCode,
        level: 1,
        subId: '',
        plotIndex: 0n,
        to: input.to,
      }),
      validUntil: ctx.protocolTime + VALIDITY_SECONDS,
    });
    return submit(client, signed);
  },

  // ── Social ────────────────────────────────────────────────────────────────

  async setProfile(
    client: ObsidianClient,
    wallet: Wallet,
    input: { accountId: string; handle: string; displayName?: string; bio?: string },
  ): Promise<SubmitResult> {
    const ctx = await context(client, wallet);
    const signed = wallet.sign({
      chainId: ctx.chainId,
      protocolVersion: PROTOCOL_VERSION,
      type: TxType.SOCIAL,
      nonce: ctx.nonce,
      gas: 0n,
      body: encodeSocialBody({
        op: SocialOp.SET_PROFILE,
        accountId: input.accountId,
        handle: input.handle,
        displayName: input.displayName,
        bio: input.bio,
      }),
      validUntil: ctx.protocolTime + VALIDITY_SECONDS,
    });
    return submit(client, signed);
  },

  async post(
    client: ObsidianClient,
    wallet: Wallet,
    input: { accountId: string; content: string; parentPostId?: string },
  ): Promise<SubmitResult> {
    const ctx = await context(client, wallet);
    const bytes = new TextEncoder().encode(input.content).length;
    const signed = wallet.sign({
      chainId: ctx.chainId,
      protocolVersion: PROTOCOL_VERSION,
      type: TxType.SOCIAL,
      nonce: ctx.nonce,
      gas: gasFor(BigInt(bytes) * 10n ** 12n),
      body: encodeSocialBody({
        op: SocialOp.POST,
        accountId: input.accountId,
        content: input.content,
        parentPostId: input.parentPostId,
      }),
      validUntil: ctx.protocolTime + VALIDITY_SECONDS,
    });
    return submit(client, signed);
  },

  async follow(
    client: ObsidianClient,
    wallet: Wallet,
    input: { accountId: string; targetAccountId: string; unfollow?: boolean },
  ): Promise<SubmitResult> {
    const ctx = await context(client, wallet);
    const signed = wallet.sign({
      chainId: ctx.chainId,
      protocolVersion: PROTOCOL_VERSION,
      type: TxType.SOCIAL,
      nonce: ctx.nonce,
      gas: 0n,
      body: encodeSocialBody({
        op: input.unfollow ? SocialOp.UNFOLLOW : SocialOp.FOLLOW,
        accountId: input.accountId,
        targetAccountId: input.targetAccountId,
      }),
      validUntil: ctx.protocolTime + VALIDITY_SECONDS,
    });
    return submit(client, signed);
  },

  async tip(
    client: ObsidianClient,
    wallet: Wallet,
    input: { accountId: string; targetAccountId: string; target: string; amountObs: string },
  ): Promise<SubmitResult> {
    const amount = parseObs(input.amountObs);
    const ctx = await context(client, wallet);
    const signed = wallet.sign({
      chainId: ctx.chainId,
      protocolVersion: PROTOCOL_VERSION,
      type: TxType.SOCIAL,
      nonce: ctx.nonce,
      gas: gasFor(amount),
      body: encodeSocialBody({
        op: SocialOp.TIP,
        accountId: input.accountId,
        targetAccountId: input.targetAccountId,
        target: input.target,
        amount,
      }),
      validUntil: ctx.protocolTime + VALIDITY_SECONDS,
    });
    return submit(client, signed);
  },

  async buyBusinessPage(client: ObsidianClient, wallet: Wallet, input: { accountId: string; priceObs: string }): Promise<SubmitResult> {
    const price = parseObs(input.priceObs);
    const ctx = await context(client, wallet);
    const signed = wallet.sign({
      chainId: ctx.chainId,
      protocolVersion: PROTOCOL_VERSION,
      type: TxType.SOCIAL,
      nonce: ctx.nonce,
      gas: gasFor(price),
      body: encodeSocialBody({ op: SocialOp.PAY_BUSINESS_PAGE, accountId: input.accountId, amount: price } as never),
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
      body: encodeTreasuryBody({ op: TreasuryOp.PAY_REVENUE, amount, purpose: input.purpose }),
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

/** Hash sealed capsule content locally. The content itself never leaves the tab. */
export async function commitContent(content: string, nonce: string): Promise<{ commitment: string; bytes: number }> {
  const data = new TextEncoder().encode(`OBSIDIAN_CAPSULE_V1|${nonce}|${content}`);
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return { commitment: hex, bytes: data.length };
}
