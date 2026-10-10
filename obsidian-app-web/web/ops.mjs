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
  TxType,
  OnsOp,
  PROTOCOL_VERSION,
  expectedGas,
} from './signing.mjs';
import { openVault, PassphraseError } from './vault.mjs';
import { parseObs, formatObs } from '../../obsidian-interface/web/core/protocol/amount.js';

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

/** Give a name this wallet owns to another address. */
export async function submitNameTransfer(deps, { name, to }) {
  return runOperation(deps, {
    async prepare(address, ctx) {
      const record = await deps.getName?.(name).catch(() => null);
      if (!record) return refusal('NAME_NOT_FOUND', `${name} is not registered`);
      if (record.owner !== address) return refusal('NAME_NOT_OWNED', `only the owner may transfer ${name}`);
      return { ok: true };
    },
    build() {
      return {
        type: TxType.ONS,
        gas: 0n,
        body: buildOnsBody({ op: OnsOp.TRANSFER, name: stripSuffix(name), to, fee: 0n }),
      };
    },
  });
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
