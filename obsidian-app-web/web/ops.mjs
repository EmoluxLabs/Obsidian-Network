/**
 * The protocol operations: the only place that touches the vault, the key and the
 * network at once.
 *
 * Everything this depends on is verified separately — derivation is pinned, signing
 * is cryptographically valid, the vault round-trips. This file's job is the
 * sequence between them, and it is deliberately narrow.
 *
 * The ordering matters and is not arbitrary:
 *
 *   1. The vault is loaded but not opened. If there is no wallet there is nothing
 *      to ask a passphrase for.
 *   2. The chain context — chain id, protocol version, protocol time — is read
 *      from the node. None of it is assumed, because a wrong chain id produces a
 *      signature every node on the real network refuses.
 *   3. Where the wallet's address is already known, the chain is asked whether the
 *      operation is even allowed *before* the phrase is decrypted. Unlocking for
 *      an operation that was never going to be permitted is wasted exposure.
 *   4. The phrase is decrypted, used to sign, and dropped. It is never cached,
 *      never logged, never returned to the caller.
 *   5. Submission goes to the node's /tx/submit with hex bytes.
 *   6. Submission is reported as submitted. Not mined, not confirmed. The caller
 *      cannot know that from a submission response, and nothing here pretends to.
 *
 * The nonce deserves a note because it is the mistake this file exists to prevent.
 * A MINING_CLAIM carries a *claim sequence* inside its body and a *nonce* in its
 * header, and they are different numbers. The nonce is the account's next
 * transaction number; the sequence is the wallet's claim counter. Signing a claim
 * with the sequence as the nonce is rejected by every node with BAD_NONCE.
 */

import {
  walletFromPhrase,
  sign,
  signLinkChallenge,
  buildMiningBody,
  buildPaymentBody,
  buildOnsBody,
  buildMarketBody,
  TxType,
  OnsOp,
  MarketOp,
  PROTOCOL_VERSION,
  expectedGas,
} from './signing.mjs';
import { openVault, PassphraseError } from './vault.mjs';
import { parseObs, formatObs } from '../../obsidian-interface/web/core/protocol/amount.js';
import { isValidAddress } from '../../obsidian-interface/web/core/crypto/keys.js';

/** How long a signed transaction stays valid. Matches the web platform's window. */
export const VALIDITY_SECONDS = 600;

/**
 * Unlock, build, sign and submit one transaction.
 *
 * `spec.prepare(address, ctx)` runs before the vault is opened when an address is
 * already known, and returns either a refusal or whatever `spec.build` needs.
 * `spec.build(wallet, ctx, prepared)` returns the unsigned fields — never a
 * signature, and never a network call of its own.
 */
async function runOperation(deps, spec) {
  const vault = deps.loadVault?.();
  if (!vault) {
    return refusal('NO_VAULT', 'No wallet is set up on this device yet.');
  }

  const context = await deps.getContext();
  const chainId = Number(context?.chainId);
  const protocolVersion = context?.protocolVersion || PROTOCOL_VERSION;
  const protocolTime = Number(context?.protocolTime);
  if (!Number.isInteger(chainId)) throw new Error('the node did not report a chain id');
  if (!Number.isFinite(protocolTime)) throw new Error('the node did not report a protocol time');
  const ctx = {
    ...context,
    chainId,
    protocolVersion,
    protocolTime,
    validUntil: Number.isFinite(context?.validUntil)
      ? Number(context.validUntil)
      : protocolTime + VALIDITY_SECONDS,
  };

  // The earliest point an address exists is the earliest point the chain can be
  // asked whether this operation is allowed at all.
  let address = deps.loadAddress?.() ?? null;
  let prepared = null;
  if (spec.prepare && address) {
    prepared = await spec.prepare(address, ctx);
    if (prepared && prepared.ok === false) return prepared;
  }

  const passphrase = await deps.requestPassphrase();
  if (!passphrase) return refusal('CANCELLED', 'Cancelled.');

  let phrase = null;
  try {
    phrase = await openVault(vault, passphrase);
    const wallet = walletFromPhrase(phrase, ctx.addressHrp);
    address = wallet.address;

    if (spec.prepare && prepared === null) {
      prepared = await spec.prepare(address, ctx);
      if (prepared && prepared.ok === false) return prepared;
    }

    const built = await spec.build(wallet, ctx, prepared);
    if (built && built.ok === false) return built;

    // The nonce is read last, from the node, for the address that is about to
    // sign. It is never the claim sequence, never a counter kept in this browser
    // and never a value the caller supplies.
    const nonce = await deps.getNonce(address);

    const signed = sign({
      wallet,
      chainId: ctx.chainId,
      protocolVersion: ctx.protocolVersion,
      nonce,
      type: built.type,
      gas: built.gas,
      body: built.body,
      memo: built.memo,
      validUntil: ctx.validUntil,
    });

    let result;
    try {
      result = await deps.submit(signed.hex, signed.txId);
    } catch (error) {
      // The transaction IS signed. Whether the node has it is unknown when the request itself failed (a timeout or a
      // dropped connection can happen after the node accepted it), so the caller is handed the signed bytes: it can
      // send the SAME transaction again (same id, same nonce: the chain cannot apply it twice) instead of signing a
      // second one that could spend the money twice. A 4xx answer is a refusal by the node: nothing was accepted.
      const status = Number(error?.status);
      return refusal('SUBMIT_FAILED', error?.message || String(error), {
        txId: signed.txId,
        signedHex: signed.hex,
        validUntil: ctx.validUntil,
        nonce,
        address,
        code: error?.code ?? null,
        refusedByNode: Number.isInteger(status) && status >= 400 && status < 500,
      });
    }
    return {
      ok: true,
      txId: signed.txId,
      // Submitted is all this knows. A caller rendering "confirmed" from this
      // value is claiming something this function cannot establish.
      state: 'submitted',
      bytes: signed.bytes.length,
      address,
      nonce,
      validUntil: ctx.validUntil,
      result,
    };
  } catch (error) {
    if (error instanceof PassphraseError) return refusal('BAD_PASSPHRASE', error.message);
    return refusal('SIGNING_FAILED', error?.message || String(error));
  } finally {
    // Drop the plaintext regardless of outcome, including on a throw. A phrase
    // that outlives the call it was decrypted for is the failure this module
    // exists to prevent.
    phrase = null;
  }
}

function refusal(reason, message, extra = {}) {
  return { ok: false, reason, message, ...extra };
}

/** A listed name is locked by consensus (`NAME_LISTED`). This says so before a passphrase is asked for. */
function listedRefusal(record, name, action) {
  if (record?.locked === true || record?.marketStatus === 'LISTED' || record?.listing) {
    return refusal('NAME_LISTED', `${name} is listed on the ONS Marketplace and cannot ${action} until the listing is removed or the name is sold`);
  }
  return null;
}

/** An address for this network, never an email, never a name. The node checks it again; this gives the reason sooner. */
function addressRefusal(ctx, value, what) {
  const text = String(value ?? '').trim();
  if (!text) return refusal('BAD_ADDRESS', `enter ${what}`);
  if (text.includes('@')) return refusal('BAD_ADDRESS', `${what} must be a wallet address, not an email address`);
  if (/\.obs$/i.test(text)) return refusal('BAD_ADDRESS', `${what} must be a wallet address; a .obs name is not accepted here`);
  if (ctx?.addressHrp && !isValidAddress(text, ctx.addressHrp)) {
    return refusal('BAD_ADDRESS', `${what} is not a valid ${ctx.addressHrp}1… wallet address for this network`);
  }
  return null;
}

/** An open (not lapsed) transfer offer. A record without an expiry is treated as open. */
function offerOpen(record, ctx) {
  if (!record.pendingTransfer) return false;
  const lapse = Number(record.pendingTransfer.offerExpiresAt);
  return !Number.isFinite(lapse) || lapse >= ctx.protocolTime;
}

// ── linking the wallet to the account ────────────────────────────────────────

/**
 * Link this device's wallet to the signed-in account, once and for good.
 *
 * One wallet per account and one account per wallet, enforced by the platform; this is the
 * client's half: it proves the key is on this device. The platform issues a challenge, the
 * wallet signs it, and only the address, public key and signature go back. Nothing is derived
 * from the account, and the phrase is decrypted, used and dropped like any other signature.
 *
 * The platform is asked first, with the cached address, so a refusal (the wallet belongs to
 * another account, or this account already has its own) arrives before any passphrase is typed.
 */
export async function linkWalletProven(deps) {
  const vault = deps.loadVault?.();
  if (!vault) return refusal('NO_VAULT', 'No wallet is set up on this device yet.');
  const cached = deps.loadAddress?.() ?? null;
  if (!cached) return refusal('NO_WALLET', 'This device has no wallet address to link.');

  let challenge;
  try {
    challenge = await deps.linkChallenge(cached);
  } catch (error) {
    return refusal(error?.code || 'LINK_REFUSED', error?.message || String(error));
  }
  if (challenge?.alreadyLinked) return { ok: true, address: cached, already: true, account: challenge.account ?? null };
  if (typeof challenge?.message !== 'string') return refusal('LINK_REFUSED', 'the platform sent no link challenge');

  const passphrase = await deps.requestPassphrase();
  if (!passphrase) return refusal('CANCELLED', 'Cancelled.');

  let phrase = null;
  try {
    const { addressHrp } = await deps.getContext();
    phrase = await openVault(vault, passphrase);
    const wallet = walletFromPhrase(phrase, addressHrp);
    if (wallet.address !== cached) {
      return refusal('WRONG_WALLET', 'The wallet in this vault does not match the address on this device; nothing was linked.');
    }
    const proof = signLinkChallenge({ wallet, message: challenge.message });
    const result = await deps.linkSubmit(proof);
    return { ok: true, address: wallet.address, already: false, account: result?.account ?? null };
  } catch (error) {
    if (error instanceof PassphraseError) return refusal('BAD_PASSPHRASE', error.message);
    return refusal(error?.code || 'LINK_FAILED', error?.message || String(error));
  } finally {
    phrase = null;
  }
}

// ── mining ───────────────────────────────────────────────────────────────────

/**
 * Claim a mining reward.
 *
 * Eligibility, the reward and the claim id are all the node's own computation.
 * The claim id in particular is derived by the protocol from chain id, address,
 * claim sequence and last claim height — a client that computed its own would be
 * refused with MINING_BAD_PROOF, and rightly so.
 *
 * A mining claim carries no gas: the executor rejects any claim whose gas is not
 * zero, because new wallets hold exactly 0 OBS by protocol rule and mining must
 * stay free.
 */
export async function submitClaim(deps) {
  return runOperation(deps, {
    async prepare(address, ctx) {
      const mining = await deps.getMiningStatus(address);
      if (!mining?.eligible) {
        return refusal(
          'NOT_ELIGIBLE',
          mining?.reason ? `not eligible: ${mining.reason}` : 'not eligible to claim yet',
          { secondsRemaining: mining?.secondsRemaining ?? null, mining },
        );
      }
      return { ok: true, mining };
    },
    async build(wallet, ctx, prepared) {
      const mining = prepared?.mining ?? {};
      // Protocol 1.7.0: the chain refuses a claim without a certificate from the mining gate. The platform issues it
      // only to a signed-in, second-factor-confirmed account for the wallet linked to it, so a refusal here is the
      // platform's answer, shown as it is — nothing is signed without one.
      if (typeof deps.getGateCertificate !== 'function') {
        return refusal('GATE_UNAVAILABLE', 'this app cannot request a mining certificate, so it cannot claim');
      }
      let gate;
      try {
        gate = await deps.getGateCertificate(wallet.address, mining.nextClaimId);
      } catch (error) {
        return refusal(error?.code || 'GATE_REFUSED', error?.message || 'the platform did not issue a mining certificate');
      }
      return {
        type: TxType.MINING_CLAIM,
        gas: 0n,
        body: buildMiningBody({
          claimId: mining.nextClaimId,
          claimSequence: mining.nextClaimSequence,
          gate,
        }),
      };
    },
  });
}

// ── payments ─────────────────────────────────────────────────────────────────

/**
 * Send OBS.
 *
 * The amount is parsed with the protocol's own parser, so "0.1" becomes exactly
 * 10^17 seals — the same string arithmetic a node performs, not a float. Gas is
 * `expectedGas(amount)`, the number the payment executor will demand; anything
 * else is refused with BAD_GAS.
 *
 * `to` must already be an address. Resolving a `.obs` name to one is the caller's
 * job: the mapping lives on the chain, and looking it up belongs in the data
 * layer where the result can be shown to the user before they sign.
 */
export async function submitPayment(deps, { to, amountObs, memo }) {
  let amount;
  try {
    amount = parseObs(amountObs);
  } catch (error) {
    return refusal('BAD_AMOUNT', error?.message || 'that is not a valid OBS amount');
  }
  if (amount <= 0n) return refusal('BAD_AMOUNT', 'amount must be greater than zero');

  const gas = expectedGas(amount);

  return runOperation(deps, {
    async prepare(address) {
      const balance = await deps.getBalance(address);
      const available = BigInt(balance?.balanceSeals ?? 0n);
      if (available < amount + gas) {
        return refusal(
          'INSUFFICIENT_FUNDS',
          `insufficient balance: you have ${formatObs(available)} OBS and this transfer needs ${formatObs(amount + gas)} OBS including gas`,
          { available: available.toString(), needed: (amount + gas).toString() },
        );
      }
      return { ok: true, balance };
    },
    build() {
      return { type: TxType.PAYMENT, gas, body: buildPaymentBody({ to, amount, memo: memo || '' }) };
    },
  });
}

// ── ONS ──────────────────────────────────────────────────────────────────────

/**
 * Register a `.obs` name.
 *
 * The fee is not a price this app chooses: consensus fixes it, and the node
 * publishes it on /params as `ons.registrationFeeObs`. Offering less is refused
 * with INSUFFICIENT_FUNDS. The fee is the protocol's only revenue source — 90%
 * to the node-runner pool and 10% to the treasury, split inside the state
 * transition rather than by any client.
 */
export async function submitNameRegistration(deps, { name, feeObs }) {
  return runOperation(deps, {
    async prepare(address, ctx) {
      const fee = requiredFee(feeObs, 'registration');
      if (fee.ok === false) return fee;
      const gas = expectedGas(fee.value);
      const record = await deps.getName?.(name).catch(() => null);
      if (record && Number(record.expiresAt) > ctx.protocolTime) {
        return refusal('NAME_TAKEN', `${name} is already registered`, { record });
      }
      const balance = await deps.getBalance(address);
      const available = BigInt(balance?.balanceSeals ?? 0n);
      if (available < fee.value + gas) {
        return refusal(
          'INSUFFICIENT_FUNDS',
          `insufficient balance: registering ${name} needs ${formatObs(fee.value + gas)} OBS including gas`,
        );
      }
      return { ok: true, fee: fee.value, gas };
    },
    build(wallet, ctx, prepared) {
      const { fee, gas } = prepared;
      return {
        type: TxType.ONS,
        gas,
        // REGISTER sets the mapping to the sender; `address` is ignored by the
        // executor, so it is left empty rather than filled with a guess.
        body: buildOnsBody({ op: OnsOp.REGISTER, name: stripSuffix(name), fee }),
      };
    },
  });
}

/** Renew a name this wallet owns. */
export async function submitNameRenewal(deps, { name, feeObs }) {
  return runOperation(deps, {
    async prepare(address, ctx) {
      const fee = requiredFee(feeObs, 'renewal');
      if (fee.ok === false) return fee;
      const gas = expectedGas(fee.value);
      const record = await deps.getName?.(name).catch(() => null);
      if (!record) return refusal('NAME_NOT_FOUND', `${name} is not registered`);
      if (record.owner !== address) return refusal('NAME_NOT_OWNED', `only the owner may renew ${name}`);
      const balance = await deps.getBalance(address);
      const available = BigInt(balance?.balanceSeals ?? 0n);
      if (available < fee.value + gas) {
        return refusal(
          'INSUFFICIENT_FUNDS',
          `insufficient balance: renewing ${name} needs ${formatObs(fee.value + gas)} OBS including gas`,
        );
      }
      return { ok: true, fee: fee.value, gas };
    },
    build(wallet, ctx, prepared) {
      const { fee, gas } = prepared;
      return { type: TxType.ONS, gas, body: buildOnsBody({ op: OnsOp.RENEW, name: stripSuffix(name), fee }) };
    },
  });
}

/** Point a name this wallet owns at a different address. */
export async function submitNameUpdate(deps, { name, address: target }) {
  return runOperation(deps, {
    async prepare(address, ctx) {
      const record = await deps.getName?.(name).catch(() => null);
      if (!record) return refusal('NAME_NOT_FOUND', `${name} is not registered`);
      if (record.owner !== address) return refusal('NAME_NOT_OWNED', `only the owner may update ${name}`);
      const locked = listedRefusal(record, name, 'be edited');
      if (locked) return locked;
      const bad = addressRefusal(ctx, target, 'the new address');
      if (bad) return bad;
      return { ok: true };
    },
    build() {
      // UPDATE_ADDRESS carries no amount, so it pays no gas.
      return {
        type: TxType.ONS,
        gas: 0n,
        body: buildOnsBody({ op: OnsOp.UPDATE_ADDRESS, name: stripSuffix(name), address: target, fee: 0n }),
      };
    },
  });
}

/**
 * Offer a name this wallet owns to another address (protocol 1.9.0). Nothing changes hands: the recipient must accept
 * (`submitNameTransferAccept`) within seven days, and the owner can withdraw the offer until then.
 */
export async function submitNameTransfer(deps, { name, to }) {
  return ownershipOperation(deps, name, OnsOp.TRANSFER, { to }, (record, address, ctx) => {
    if (record.owner !== address) return ['NAME_NOT_OWNED', `only the owner may offer ${name}`];
    const bad = addressRefusal(ctx, to, 'the recipient');
    if (bad) return [bad.reason, bad.message];
    if (to === record.owner) return ['BAD_RECIPIENT', 'the recipient already owns this name'];
    if (offerOpen(record, ctx)) return ['OFFER_OPEN', `an offer to ${record.pendingTransfer.to} is already open: withdraw it first`];
    return null;
  }, 'be transferred outside the Marketplace');
}

/** Take a name that was offered to this wallet. */
export async function submitNameTransferAccept(deps, { name }) {
  return ownershipOperation(deps, name, OnsOp.ACCEPT_TRANSFER, {}, (record, address, ctx) => {
    if (record.pendingTransfer?.to !== address) return ['NO_OFFER', `${name} has not been offered to this wallet`];
    const lapsed = Number(record.pendingTransfer.offerExpiresAt);
    if (Number.isFinite(lapsed) && lapsed < ctx.protocolTime) return ['OFFER_LAPSED', 'the transfer offer has lapsed (offers last seven days)'];
    return null;
  }, 'be transferred outside the Marketplace');
}

/** Withdraw an open offer (owner only). */
export async function submitNameTransferCancel(deps, { name }) {
  return ownershipOperation(deps, name, OnsOp.CANCEL_TRANSFER, {}, (record, address) =>
    record.owner !== address ? ['NAME_NOT_OWNED', `only the owner may withdraw an offer on ${name}`] : record.pendingTransfer ? null : ['NO_OFFER', `${name} has no open offer`],
  );
}

/** Set (or clear, with an empty address) the recovery address of a name this wallet owns. */
export async function submitNameRecoverySet(deps, { name, address: recovery }) {
  return ownershipOperation(deps, name, OnsOp.SET_RECOVERY, { address: recovery ?? '' }, (record, address, ctx) => {
    if (record.owner !== address) return ['NAME_NOT_OWNED', `only the owner may set the recovery address of ${name}`];
    if (record.pendingRecovery) return ['RECOVERY_IN_FLIGHT', 'a recovery is in flight: cancel it before changing the recovery address'];
    if (recovery) {
      const bad = addressRefusal(ctx, recovery, 'the recovery address');
      if (bad) return [bad.reason, bad.message];
      if (recovery === record.owner) return ['BAD_RECIPIENT', 'the recovery address must differ from the owner'];
    }
    return null;
  }, 'have its recovery address changed');
}

/** Signed by the recovery address: propose a new owner. It takes effect only after the recovery delay. */
export async function submitNameRecoveryStart(deps, { name, newOwner }) {
  return ownershipOperation(deps, name, OnsOp.START_RECOVERY, { address: newOwner }, (record, address, ctx) => {
    if (record.recoveryAddress !== address) return ['NOT_RECOVERY_ADDRESS', `this wallet is not the recovery address of ${name}`];
    if (record.pendingRecovery) return ['RECOVERY_IN_FLIGHT', 'a recovery is already in flight'];
    const bad = addressRefusal(ctx, newOwner, 'the new owner');
    if (bad) return [bad.reason, bad.message];
    if (newOwner === record.owner) return ['BAD_RECIPIENT', 'the new owner is already the owner'];
    return null;
  }, 'be recovered');
}

/** The current owner cancels a recovery in flight. */
export async function submitNameRecoveryCancel(deps, { name }) {
  return ownershipOperation(deps, name, OnsOp.CANCEL_RECOVERY, {}, (record, address) =>
    record.owner !== address ? ['NAME_NOT_OWNED', `only the owner may cancel a recovery of ${name}`] : record.pendingRecovery ? null : ['NO_RECOVERY', `${name} has no recovery in flight`],
  );
}

/** Complete a recovery once its delay has passed (the recovery address or the new owner). */
export async function submitNameRecoveryFinalize(deps, { name }) {
  return ownershipOperation(deps, name, OnsOp.FINALIZE_RECOVERY, {}, (record, address, ctx) => {
    const recovery = record.pendingRecovery;
    if (!recovery) return ['NO_RECOVERY', `${name} has no recovery in flight`];
    if (recovery.by !== address && recovery.newAddress !== address) return ['UNAUTHORIZED', 'only the recovery address or the new owner may complete it'];
    const effective = Number(recovery.effectiveAt);
    if (Number.isFinite(effective) && ctx.protocolTime < effective) return ['RECOVERY_NOT_READY', 'the recovery delay has not passed yet', { effectiveAt: effective }];
    return null;
  }, 'be recovered');
}

/**
 * One zero-gas ONS ownership operation. The pre-check reads the on-chain record so the user gets a plain refusal
 * instead of a rejected transaction; consensus makes the same checks again and is the only authority.
 */
async function ownershipOperation(deps, name, op, fields, check, lockedAction) {
  return runOperation(deps, {
    async prepare(address, ctx) {
      const record = await deps.getName?.(name).catch(() => null);
      if (!record) return refusal('NAME_NOT_FOUND', `${name} is not registered`);
      const problem = check(record, address, ctx);
      if (problem) return refusal(problem[0], problem[1], problem[2] ?? {});
      // The Marketplace lock is checked after the role: a stranger is told it is not theirs, not that it is listed.
      const locked = lockedAction ? listedRefusal(record, name, lockedAction) : null;
      if (locked) return locked;
      return { ok: true };
    },
    build() {
      return { type: TxType.ONS, gas: 0n, body: buildOnsBody({ op, name: stripSuffix(name), fee: 0n, ...fields }) };
    },
  });
}

// ── ONS Marketplace (protocol 2.0.0) ─────────────────────────────────────────────────────────────────────────────
//
// Each operation reads the authoritative market record before the vault is opened and refuses plainly when it no longer
// matches what the person reviewed. That is a courtesy: consensus makes every one of these checks again, and a stale
// screen can never authorise anything. Only BUY and OFFER move an amount, so only they carry gas (never taken from
// escrow); every other Marketplace operation is zero-gas.

const lower = (name) => stripSuffix(name);

function spendable(balance) {
  return BigInt(balance?.spendableSeals ?? balance?.balanceSeals ?? 0n);
}

async function marketOperation(deps, check, build) {
  return runOperation(deps, {
    async prepare(address, ctx) {
      return check(address, ctx);
    },
    build(wallet, ctx, prepared) {
      return build(prepared);
    },
  });
}

function positiveSeals(amountObs, what) {
  try {
    const value = parseObs(amountObs);
    if (value <= 0n) return refusal('BAD_AMOUNT', `${what} must be greater than zero`);
    return { ok: true, value };
  } catch (error) {
    return refusal('BAD_AMOUNT', `${what} is not an OBS amount (${error?.message ?? 'invalid'})`);
  }
}

/** List a name this wallet owns at a fixed price. The name is locked until the listing is removed or sold. */
export async function submitMarketList(deps, { name, priceObs }) {
  return marketOperation(
    deps,
    async (address) => {
      const price = positiveSeals(priceObs, 'the price');
      if (price.ok === false) return price;
      const status = await deps.getMarketName(lower(name)).catch(() => null);
      if (!status || status.owner !== address) return refusal('NAME_NOT_OWNED', `only the owner may list ${name}`);
      if (status.status === 'LISTED') return refusal('ALREADY_LISTED', `${name} is already listed`);
      if (status.status !== 'OWNED') return refusal('NOT_ACTIVE', `${name} is not active`);
      return { ok: true, price: price.value };
    },
    ({ price }) => ({ type: TxType.ONS_MARKET, gas: 0n, body: buildMarketBody({ op: MarketOp.LIST, name: lower(name), amount: price }) }),
  );
}

export async function submitMarketUpdate(deps, { name, priceObs }) {
  return marketOperation(
    deps,
    async (address) => {
      const price = positiveSeals(priceObs, 'the price');
      if (price.ok === false) return price;
      const status = await deps.getMarketName(lower(name)).catch(() => null);
      if (!status || status.status !== 'LISTED' || status.owner !== address) return refusal('NOT_LISTED', `you have no active listing for ${name}`);
      return { ok: true, price: price.value };
    },
    ({ price }) => ({ type: TxType.ONS_MARKET, gas: 0n, body: buildMarketBody({ op: MarketOp.UPDATE_PRICE, name: lower(name), amount: price }) }),
  );
}

export async function submitMarketDelist(deps, { name }) {
  return marketOperation(
    deps,
    async (address) => {
      const status = await deps.getMarketName(lower(name)).catch(() => null);
      if (!status || status.status !== 'LISTED' || status.owner !== address) return refusal('NOT_LISTED', `you have no active listing for ${name}`);
      return { ok: true };
    },
    () => ({ type: TxType.ONS_MARKET, gas: 0n, body: buildMarketBody({ op: MarketOp.DELIST, name: lower(name) }) }),
  );
}

/** Buy a listed name at the price and from the seller that were reviewed. A changed listing is refused here and by the chain. */
export async function submitMarketBuy(deps, { name, reviewedPriceSeals, reviewedSeller }) {
  return marketOperation(
    deps,
    async (address) => {
      const status = await deps.getMarketName(lower(name)).catch(() => null);
      const listing = status?.listing;
      if (!status || status.status !== 'LISTED' || !listing) return refusal('NOT_LISTED', `${name} is no longer listed: it may have been sold or the listing removed`);
      if (listing.seller === address) return refusal('OWN_LISTING', 'you cannot buy your own listing');
      if (String(listing.priceSeals) !== String(reviewedPriceSeals) || listing.seller !== reviewedSeller) {
        return refusal('LISTING_CHANGED', 'the listing changed since you reviewed it: review the new price and seller, then try again');
      }
      const price = BigInt(listing.priceSeals);
      const gas = expectedGas(price);
      const have = spendable(await deps.getBalance(address));
      if (have < price + gas) {
        return refusal('INSUFFICIENT_FUNDS', `insufficient spendable balance: this purchase needs ${formatObs(price + gas)} OBS including gas (funds locked in offers are not spendable)`);
      }
      return { ok: true, price, gas, seller: listing.seller };
    },
    ({ price, gas, seller }) => ({
      type: TxType.ONS_MARKET,
      gas,
      body: buildMarketBody({ op: MarketOp.BUY, name: lower(name), amount: price, counterparty: seller }),
    }),
  );
}

/** Offer OBS for an owned, unlisted name: the amount is locked in escrow at once, gas is charged on top. */
export async function submitMarketOffer(deps, { name, amountObs, reviewedOwner }) {
  return marketOperation(
    deps,
    async (address) => {
      const amount = positiveSeals(amountObs, 'the offer');
      if (amount.ok === false) return amount;
      const status = await deps.getMarketName(lower(name)).catch(() => null);
      if (!status) return refusal('NAME_NOT_FOUND', `${name} could not be read from the node`);
      if (status.status === 'LISTED') return refusal('LISTED', `${name} is listed for sale: buy it at the listed price instead`);
      if (status.status !== 'OWNED' || !status.owner) return refusal('NOT_OWNED', `${name} has no active owner to receive an offer`);
      if (status.owner === address) return refusal('OWN_NAME', 'you own this name');
      if (reviewedOwner && status.owner !== reviewedOwner) return refusal('OWNER_CHANGED', 'the owner changed since you reviewed this: review again');
      const gas = expectedGas(amount.value);
      const have = spendable(await deps.getBalance(address));
      if (have < amount.value + gas) {
        return refusal('INSUFFICIENT_FUNDS', `insufficient spendable balance: this offer needs ${formatObs(amount.value + gas)} OBS including gas`);
      }
      return { ok: true, amount: amount.value, gas, owner: status.owner };
    },
    ({ amount, gas, owner }) => ({
      type: TxType.ONS_MARKET,
      gas,
      body: buildMarketBody({ op: MarketOp.OFFER, name: lower(name), amount, counterparty: owner }),
    }),
  );
}

async function offerOperation(deps, offerId, op, check) {
  return marketOperation(
    deps,
    async (address) => {
      const found = await deps.getMarketOffer(offerId).catch(() => null);
      const offer = found?.offer;
      if (!offer) return refusal('OFFER_NOT_FOUND', 'that offer could not be read from the node');
      if (offer.status !== 'PENDING') return refusal('OFFER_CLOSED', `this offer is already ${String(offer.status).toLowerCase()}`);
      const problem = check(offer, address);
      if (problem) return refusal(problem[0], problem[1]);
      return { ok: true, offer };
    },
    ({ offer }) => ({
      type: TxType.ONS_MARKET,
      gas: 0n,
      body: buildMarketBody({
        op,
        name: lower(offer.name),
        offerId: offer.id,
        amount: op === MarketOp.ACCEPT_OFFER ? BigInt(offer.amountSeals) : 0n,
      }),
    }),
  );
}

/** Owner: accept a pending offer. The name moves to the maker and the escrow is paid to the owner in one step. */
export async function submitMarketAccept(deps, { offerId }) {
  return offerOperation(deps, offerId, MarketOp.ACCEPT_OFFER, (offer, address) =>
    offer.currentOwner === address ? null : ['NOT_OWNER', 'only the current owner of the name may accept this offer'],
  );
}

/** Owner: decline a pending offer. The escrow returns to the maker. */
export async function submitMarketDecline(deps, { offerId }) {
  return offerOperation(deps, offerId, MarketOp.DECLINE_OFFER, (offer, address) =>
    offer.currentOwner === address ? null : ['NOT_OWNER', 'only the current owner of the name may decline this offer'],
  );
}

/** Maker: cancel your own pending offer. The escrow returns to you. */
export async function submitMarketCancel(deps, { offerId }) {
  return offerOperation(deps, offerId, MarketOp.CANCEL_OFFER, (offer, address) =>
    offer.maker === address ? null : ['NOT_MAKER', 'only the maker may cancel an offer'],
  );
}

function requiredFee(feeObs, label) {
  try {
    const value = parseObs(feeObs);
    if (value < 0n) throw new Error('a fee cannot be negative');
    return { ok: true, value };
  } catch (error) {
    return refusal('BAD_FEE', `the node did not publish a usable ${label} fee (${error?.message ?? 'none'})`);
  }
}

function stripSuffix(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\.obs$/, '');
}

export { OnsOp, TxType, expectedGas, parseObs, formatObs, PROTOCOL_VERSION };
