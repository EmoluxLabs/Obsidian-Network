/**
 * SOCIAL — OBS Social on-chain state (spec §33–§38).
 *
 * What lives on-chain: identity handles, follow graph counters, posts (content
 * hash + body), tips, business-page activations, verification tiers, creator
 * monetisation eligibility and the 70/30 creator revenue split.
 *
 * What stays off-chain: the feed cache, search indexes, notifications, media.
 * Those are caches; the blockchain is the record.
 *
 * Wallet rules: tips and payments are direct OBS transfers between user
 * wallets. The protocol never creates an "internal balance" and never lets a
 * database become the source of truth for money.
 */

import { Reader, Writer } from '../../protocol/encoding.js';
import { CONSENSUS_PARAMS } from '../../protocol/params.js';
import { ErrCode, reject } from '../../protocol/errors.js';
import { SocialOp, type SocialBody, type SocialRecord, type TxEnvelope } from '../../protocol/types.js';
import {
  assertAddress,
  assertAmount,
  assertGas,
  requirePrice,
  splitBps,
  usdMicroToSeals,
} from '../helpers.js';
import { treasuryWallet } from '../../genesis/rules.js';
import { fromHex, toHex, sha256, utf8, domainHash } from '../../crypto/hash.js';
import { DOMAIN } from '../../protocol/domains.js';
import { RevenueSource } from '../../economy/accounting.js';
import type { ExecutorContext } from '../types.js';

const HANDLE_PATTERN = /^[a-z0-9_](?:[a-z0-9_.]{1,22})[a-z0-9_]$/;

export function decodeSocialBody(body: Uint8Array): SocialBody {
  const r = new Reader(body);
  const op = r.u8() as SocialOp;
  const accountId = r.string();
  const handle = r.string();
  const displayName = r.string();
  const bio = r.string();
  const avatarHash = r.string();
  const postId = r.string();
  const content = r.string();
  const parentPostId = r.string();
  const target = r.string();
  const targetAccountId = r.string();
  const amount = r.u128();
  const kind = r.string();
  const metadataHash = r.string();
  const tier = r.string();
  r.ensureConsumed();
  return {
    op,
    accountId: accountId || undefined,
    handle: handle || undefined,
    displayName: displayName || undefined,
    bio: bio || undefined,
    avatarHash: avatarHash || undefined,
    postId: postId || undefined,
    content: content || undefined,
    parentPostId: parentPostId || undefined,
    target: target || undefined,
    targetAccountId: targetAccountId || undefined,
    amount: amount > 0n ? amount : undefined,
    kind: (kind || undefined) as SocialBody['kind'],
    metadataHash: metadataHash || undefined,
    tier: (tier || undefined) as SocialBody['tier'],
  };
}

export function encodeSocialBody(body: SocialBody): Uint8Array {
  const w = new Writer();
  w.u8(body.op);
  w.string(body.accountId ?? '');
  w.string(body.handle ?? '');
  w.string(body.displayName ?? '');
  w.string(body.bio ?? '');
  w.string(body.avatarHash ?? '');
  w.string(body.postId ?? '');
  w.string(body.content ?? '');
  w.string(body.parentPostId ?? '');
  w.string(body.target ?? '');
  w.string(body.targetAccountId ?? '');
  w.u128(body.amount ?? 0n);
  w.string(body.kind ?? '');
  w.string(body.metadataHash ?? '');
  w.string(body.tier ?? '');
  return w.finish();
}

/** Deterministic post id: content-addressed, so edits and forks are visible. */
export function computePostId(
  authorAddress: string,
  accountId: string,
  content: string,
  parentPostId: string,
  nonce: number,
): string {
  return toHex(
    domainHash(
      DOMAIN.TX,
      utf8(`POST|${authorAddress}|${accountId}|${parentPostId}|${nonce}`),
      sha256(utf8(content)),
    ),
  ).slice(0, 48);
}

function requireAccountId(body: SocialBody): string {
  const accountId = body.accountId ?? '';
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(accountId)) {
    reject(ErrCode.MALFORMED, 'accountId must be 8-64 characters of [A-Za-z0-9_-]');
  }
  return accountId;
}

export function executeSocial(
  ctx: ExecutorContext,
  tx: TxEnvelope,
): { gasBase: bigint; detail: Record<string, unknown> } {
  const { state, apply, net } = ctx;
  const body = decodeSocialBody(tx.body);
  const protocolTime = apply.timestamp;
  const treasury = treasuryWallet(state);

  switch (body.op) {
    case SocialOp.SET_PROFILE: {
      const accountId = requireAccountId(body);
      const handle = (body.handle ?? '').toLowerCase();
      if (!HANDLE_PATTERN.test(handle) || handle.length > CONSENSUS_PARAMS.social.maxUsernameLength) {
        reject(ErrCode.MALFORMED, 'handle must be 2-24 characters of [a-z0-9_.] starting and ending alphanumeric');
      }
      const existing = state.s.social.get(accountId);
      if (existing && existing.owner !== tx.sender) {
        reject(ErrCode.UNAUTHORIZED, 'that social account belongs to another wallet');
      }
      for (const record of state.s.social.values()) {
        if (record.handle === handle && record.accountId !== accountId) {
          reject(ErrCode.NAME_TAKEN, `handle @${handle} is already in use`);
        }
      }
      assertGas(tx.gas, 0n);
      const record: SocialRecord = existing ?? {
        accountId,
        handle,
        displayName: body.displayName ?? handle,
        bio: body.bio ?? '',
        avatarHash: body.avatarHash,
        owner: tx.sender,
        createdAt: protocolTime,
        followers: 0,
        following: 0,
        postCount: 0,
        monthlyViews: 0,
        earnings: 0n,
        tier: 'NONE',
        businessPage: false,
        monetisationEnabled: false,
      };
      record.handle = handle;
      if (body.displayName !== undefined) record.displayName = body.displayName.slice(0, 64);
      if (body.bio !== undefined) record.bio = body.bio.slice(0, 512);
      if (body.avatarHash !== undefined) {
        if (!/^[0-9a-f]{64}$/.test(body.avatarHash)) reject(ErrCode.MALFORMED, 'avatarHash must be a SHA-256 digest');
        record.avatarHash = body.avatarHash;
      }
      state.s.social.set(accountId, record);
      state.emit('SOCIAL_PROFILE_SET', { accountId, handle, owner: tx.sender }, apply);
      return { gasBase: 0n, detail: { accountId, handle } };
    }

    case SocialOp.FOLLOW:
    case SocialOp.UNFOLLOW: {
      const accountId = requireAccountId(body);
      const targetAccountId = body.targetAccountId ?? '';
      if (targetAccountId === accountId) reject(ErrCode.MALFORMED, 'an account cannot follow itself');
      const me = state.s.social.get(accountId);
      const target = state.s.social.get(targetAccountId);
      if (!me) reject(ErrCode.NOT_FOUND, 'create your social profile first');
      if (!target) reject(ErrCode.NOT_FOUND, 'that account does not exist');
      if (me.owner !== tx.sender) reject(ErrCode.UNAUTHORIZED, 'signer does not own that social account');
      assertGas(tx.gas, 0n);
      const followKey = `${accountId}->${targetAccountId}`;
      const isFollowing = state.s.socialFollowing.has(followKey);
      if (body.op === SocialOp.FOLLOW && !isFollowing) {
        if (me.following >= 100_000) reject(ErrCode.RATE_LIMITED, 'following limit reached');
        state.s.socialFollowing.add(followKey);
        me.following += 1;
        target.followers += 1;
        state.emit('SOCIAL_FOLLOW', { accountId, targetAccountId }, apply);
      }
      if (body.op === SocialOp.UNFOLLOW && isFollowing) {
        state.s.socialFollowing.delete(followKey);
        me.following = Math.max(0, me.following - 1);
        target.followers = Math.max(0, target.followers - 1);
        state.emit('SOCIAL_UNFOLLOW', { accountId, targetAccountId }, apply);
      }
      return { gasBase: 0n, detail: { accountId, targetAccountId, following: body.op === SocialOp.FOLLOW } };
    }

    case SocialOp.POST: {
      const accountId = requireAccountId(body);
      const profile = state.s.social.get(accountId);
      if (!profile) reject(ErrCode.NOT_FOUND, 'create your social profile first');
      if (profile.owner !== tx.sender) reject(ErrCode.UNAUTHORIZED, 'signer does not own that social account');
      const content = body.content ?? '';
      if (Buffer.byteLength(content, 'utf8') === 0) reject(ErrCode.MALFORMED, 'a post needs content');
      const isComment = Boolean(body.parentPostId);
      const limit = isComment ? CONSENSUS_PARAMS.social.maxCommentBytes : CONSENSUS_PARAMS.social.maxPostBytes;
      if (Buffer.byteLength(content, 'utf8') > limit) reject(ErrCode.MALFORMED, `content exceeds ${limit} bytes`);
      if (isComment && !state.s.posts.has(body.parentPostId!)) {
        reject(ErrCode.NOT_FOUND, 'the parent post does not exist');
      }
      // A post costs gas proportional to its size: protocol anti-spam, and the
      // gas goes to the Mining Pool where it funds mining rewards.
      const size = BigInt(Buffer.byteLength(content, 'utf8'));
      const gasBase = size * 10n ** 12n; // 1e-6 OBS per byte at 0.02% gas
      const gas = assertGas(tx.gas, gasBase);
      if (gas > 0n) {
        state.debit(tx.sender, gas, apply, 'post gas');
        state.poolInflow(gas, 'social post gas to mining pool');
        state.s.metrics.totalGasBurnedToPool += gas;
      }
      const postId = body.postId ?? computePostId(tx.sender, accountId, content, body.parentPostId ?? '', profile.postCount);
      if (state.s.posts.has(postId)) reject(ErrCode.REPLAY, 'that post id already exists');
      state.s.posts.set(postId, {
        postId,
        authorAccountId: accountId,
        authorAddress: tx.sender,
        content,
        parentPostId: body.parentPostId,
        createdAt: protocolTime,
        createdAtHeight: apply.height,
        deleted: false,
        likes: 0,
      });
      profile.postCount += 1;
      state.emit('SOCIAL_POST', {
        postId,
        accountId,
        author: tx.sender,
        parentPostId: body.parentPostId ?? null,
        bytes: content.length,
      }, apply);
      return { gasBase, detail: { postId, accountId } };
    }

    case SocialOp.DELETE_POST: {
      const accountId = requireAccountId(body);
      const post = state.s.posts.get(body.postId ?? '');
      if (!post) reject(ErrCode.NOT_FOUND, 'no such post');
      if (post.authorAddress !== tx.sender) reject(ErrCode.UNAUTHORIZED, 'only the author may delete a post');
      assertGas(tx.gas, 0n);
      post.deleted = true;
      post.content = '';
      state.emit('SOCIAL_POST_DELETED', { postId: post.postId, accountId }, apply);
      return { gasBase: 0n, detail: { postId: post.postId } };
    }

    case SocialOp.TIP: {
      if (!body.target) reject(ErrCode.MALFORMED, 'a recipient wallet is required');
      assertAddress(body.target, net, 'tip recipient');
      assertAmount(body.amount ?? 0n, { label: 'tip' });
      const amount = body.amount!;
      if (amount < CONSENSUS_PARAMS.social.minTip) reject(ErrCode.AMOUNT_ZERO, 'tip is below the protocol minimum');
      const gas = assertGas(tx.gas, amount);
      state.debit(tx.sender, amount + gas, apply, 'tip + gas');
      state.credit(body.target, amount, apply, 'tip received (100% to the recipient wallet)');
      if (gas > 0n) {
        state.poolInflow(gas, 'tip gas to mining pool');
        state.s.metrics.totalGasBurnedToPool += gas;
      }
      state.s.metrics.totalTips += amount;
      if (body.targetAccountId) {
        const profile = state.s.social.get(body.targetAccountId);
        if (profile) profile.earnings += amount;
      }
      state.emit('SOCIAL_TIP', {
        from: tx.sender,
        to: body.target,
        amount: amount.toString(),
        postId: body.postId ?? null,
        note: body.content ?? null,
      }, apply);
      return { gasBase: amount, detail: { to: body.target, amount: amount.toString() } };
    }

    case SocialOp.PAY_BUSINESS_PAGE: {
      const accountId = requireAccountId(body);
      const profile = state.s.social.get(accountId);
      if (!profile) reject(ErrCode.NOT_FOUND, 'create your social profile first');
      if (profile.owner !== tx.sender) reject(ErrCode.UNAUTHORIZED, 'signer does not own that social account');
      if (profile.businessPage) reject(ErrCode.REPLAY, 'this account already has a business page');
      if (!treasury) {
        reject(ErrCode.ORACLE_UNAVAILABLE, 'treasury wallet is not yet designated on-chain (no valid miner yet)');
      }
      const price = requirePrice(state, protocolTime);
      const priceObs = usdMicroToSeals(CONSENSUS_PARAMS.social.businessPagePriceUsd, price.priceUsdMicro);
      const gas = assertGas(tx.gas, priceObs);
      state.debit(tx.sender, priceObs + gas, apply, 'business page activation + gas');
      // Qualifying platform revenue: split 40/60 before anything reaches the
      // treasury (see src/economy/accounting.ts).
      state.creditPlatformRevenue(RevenueSource.BUSINESS_PAGE, priceObs, apply, `business page ${accountId}`);
      if (gas > 0n) {
        state.poolInflow(gas, 'business page gas to mining pool');
        state.s.metrics.totalGasBurnedToPool += gas;
      }
      profile.businessPage = true;
      const owner = state.touchAccount(tx.sender, apply);
      owner.flags.businessPage = true;
      state.emit('SOCIAL_BUSINESS_PAGE_ACTIVATED', {
        accountId,
        owner: tx.sender,
        priceObs: priceObs.toString(),
        treasury,
      }, apply);
      return { gasBase: priceObs, detail: { accountId, priceObs: priceObs.toString(), treasury } };
    }

    case SocialOp.REQUEST_VERIFICATION: {
      const accountId = requireAccountId(body);
      const profile = state.s.social.get(accountId);
      if (!profile) reject(ErrCode.NOT_FOUND, 'create your social profile first');
      const tier = body.tier ?? 'BLUE';
      if (tier === 'GOLD' && !profile.businessPage) {
        reject(ErrCode.UNAUTHORIZED, 'a gold badge requires an active business page');
      }
      assertGas(tx.gas, 0n);
      state.s.verificationRequests.set(accountId, {
        tier,
        requestedBy: tx.sender,
        requestedAtHeight: apply.height,
        evidenceHash: body.metadataHash ?? '',
      });
      state.emit('SOCIAL_VERIFICATION_REQUESTED', { accountId, tier, evidenceHash: body.metadataHash ?? null }, apply);
      return { gasBase: 0n, detail: { accountId, tier, status: 'PENDING' } };
    }

    case SocialOp.SET_MONETISATION: {
      const accountId = requireAccountId(body);
      const profile = state.s.social.get(accountId);
      if (!profile) reject(ErrCode.NOT_FOUND, 'create your social profile first');
      assertGas(tx.gas, 0n);
      // Only the platform verification authority (the designated treasury / the
      // foundation it designates) may flip monetisation or verification tiers on-chain.
      if (tx.sender !== treasury) {
        reject(
          ErrCode.UNAUTHORIZED,
          'only the designated platform authority may grant monetisation or verification tiers',
        );
      }
      if (body.kind === 'CREATOR_PAYOUT') {
        profile.monetisationEnabled = true;
      }
      const record = profile;
      if (body.tier === 'BLUE') record.tier = 'BLUE';
      if (body.tier === 'GOLD') record.tier = 'GOLD';
      state.emit('SOCIAL_ATTESTATION', {
        accountId,
        tier: record.tier,
        monetisation: record.monetisationEnabled,
        followers: record.followers,
        monthlyViews: record.monthlyViews,
      }, apply);
      return { gasBase: 0n, detail: { accountId, tier: record.tier } };
    }

    case SocialOp.ATTEST_VIEWS: {
      const accountId = requireAccountId(body);
      const profile = state.s.social.get(accountId);
      if (!profile) reject(ErrCode.NOT_FOUND, 'create your social profile first');
      assertGas(tx.gas, 0n);
      if (tx.sender !== treasury) {
        reject(ErrCode.UNAUTHORIZED, 'only the designated platform authority may attest view counts');
      }
      const views = Number(body.amount ?? 0n);
      if (!Number.isFinite(views) || views < 0 || views > 1_000_000_000) {
        reject(ErrCode.MALFORMED, 'view count is out of range');
      }
      profile.monthlyViews = views;
      state.emit('SOCIAL_VIEWS_ATTESTED', { accountId, monthlyViews: views }, apply);
      return { gasBase: 0n, detail: { accountId, monthlyViews: views } };
    }

    default:
      reject(ErrCode.UNKNOWN_TX_TYPE, `unsupported social operation ${body.op}`);
  }
}

/**
 * Creator view revenue distribution (spec §36): 70% to the creator's wallet,
 * 30% to the Obsidian Network treasury wallet. Paid in a normal signed
 * transaction; the payer's funds are never routed anywhere else, and the split
 * only applies once the creator meets the published eligibility thresholds.
 */
export function executeViewRevenue(
  ctx: ExecutorContext,
  tx: TxEnvelope,
  creatorAccountId: string,
  amount: bigint,
): { gasBase: bigint; detail: Record<string, unknown> } {
  const { state, apply } = ctx;
  const profile = state.s.social.get(creatorAccountId);
  if (!profile) reject(ErrCode.NOT_FOUND, 'no such creator account');
  if (!profile.monetisationEnabled) {
    reject(ErrCode.UNAUTHORIZED, 'creator is not monetisation-enabled (thresholds not met or not attested)');
  }
  if (profile.followers < CONSENSUS_PARAMS.social.monetisationMinFollowers) {
    reject(ErrCode.UNAUTHORIZED, `creator needs ${CONSENSUS_PARAMS.social.monetisationMinFollowers} followers`);
  }
  if (profile.monthlyViews < CONSENSUS_PARAMS.social.monetisationMinMonthlyViews) {
    reject(ErrCode.UNAUTHORIZED, `creator needs ${CONSENSUS_PARAMS.social.monetisationMinMonthlyViews} monthly views`);
  }
  const treasury = treasuryWallet(state);
  if (!treasury) reject(ErrCode.ORACLE_UNAVAILABLE, 'treasury wallet is not yet designated on-chain');
  assertAmount(amount, { label: 'revenue' });
  const gas = assertGas(tx.gas, amount);
  const creatorShare = splitBps(amount, CONSENSUS_PARAMS.social.creatorShareBps);
  const networkShare = amount - creatorShare;
  state.debit(tx.sender, amount + gas, apply, 'creator revenue + gas');
  state.credit(profile.owner, creatorShare, apply, 'creator revenue share (70%)');
  state.credit(treasury, networkShare, apply, 'network revenue share (30%) to treasury');
  if (gas > 0n) {
    state.poolInflow(gas, 'revenue gas to mining pool');
    state.s.metrics.totalGasBurnedToPool += gas;
  }
  profile.earnings += creatorShare;
  state.s.metrics.totalCreatorEarnings += creatorShare;
  state.s.metrics.totalTreasuryRevenue += networkShare;
  state.emit('SOCIAL_VIEW_REVENUE', {
    creatorAccountId,
    creatorWallet: profile.owner,
    payer: tx.sender,
    amount: amount.toString(),
    creatorShare: creatorShare.toString(),
    networkShare: networkShare.toString(),
    treasury,
  }, apply);
  return {
    gasBase: amount,
    detail: { creatorShare: creatorShare.toString(), networkShare: networkShare.toString(), treasury },
  };
}

export function avatarDigest(value: string): string {
  return toHex(sha256(fromHex(value)));
}
