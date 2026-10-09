/**
 * The claim caller: the only place that touches all three pieces at once.
 *
 * Everything it depends on is verified separately — derivation is pinned, signing is
 * cryptographically valid, the vault round-trips. This file's job is the sequence
 * between them, and it is deliberately narrow.
 *
 * The ordering matters and is not arbitrary:
 *
 *   1. Eligibility comes from the platform before anything is derived. If the wallet
 *      cannot claim, there is no reason to put a recovery phrase in memory at all.
 *   2. The phrase is decrypted, used to sign, and dropped. It is never cached, never
 *      logged, never returned to the caller.
 *   3. The transaction id is computed with computeTxId. The envelope carries no txId,
 *      so reading one off it yields undefined — which is how a UI ends up showing
 *      "confirmed" for a transaction that was never identified.
 *   4. Submission goes to the node's /tx/submit. The RPC submittransaction method
 *      always throws; using it here would fail every claim.
 *   5. Submission is reported as submitted. Not mined, not confirmed. The caller
 *      cannot know that from a submission response, and nothing here pretends to.
 */

import { walletFromPhrase, sign, claimDigest, TxType } from './signing.mjs';
import { openVault } from './vault.mjs';
import { computeTxId, encodeSignedTx } from '../../obsidian-interface/web/core/transactions/encode.js';

/**
 * @param {object} deps Injected so a caller cannot accidentally reach the network.
 * @param {Function} deps.getEligibility Returns the platform's MiningEligibility.
 * @param {Function} deps.loadVault Returns the stored vault envelope.
 * @param {Function} deps.requestPassphrase Asks the user, returns their passphrase.
 * @param {Function} deps.submit POSTs encoded bytes to the node's /tx/submit.
 */
export async function submitClaim(deps) {
  const { getEligibility, loadVault, requestPassphrase, submit, chainId, protocolVersion } = deps;

  const vault = loadVault();
  if (!vault) {
    return { ok: false, reason: 'NO_VAULT', message: 'No wallet is set up on this device yet.' };
  }

  // Eligibility first. Checking it after unlocking would mean decrypting a phrase
  // for a claim that was never going to be allowed.
  const eligibility = await getEligibility();
  if (!eligibility?.eligible) {
    return {
      ok: false,
      reason: 'NOT_ELIGIBLE',
      message: eligibility?.reason ?? 'Not eligible to claim yet.',
      secondsRemaining: eligibility?.secondsRemaining ?? null,
    };
  }

  const passphrase = await requestPassphrase();
  if (!passphrase) return { ok: false, reason: 'CANCELLED', message: 'Claim cancelled.' };

  let phrase;
  try {
    phrase = await openVault(vault, passphrase);
  } catch (error) {
    return { ok: false, reason: 'BAD_PASSPHRASE', message: error.message };
  }

  try {
    const wallet = walletFromPhrase(phrase);
    const sequence = eligibility.nextClaimSequence ?? 0;
    const digest = claimDigest(sequence);

    const envelope = sign({
      wallet,
      chainId,
      protocolVersion,
      nonce: sequence,
      type: TxType.MINING_CLAIM,
      body: digest,
      validUntil: 0,
    });

    // The envelope has no txId. This call is the only way to get one.
    const txId = computeTxId(envelope.unsigned ?? envelope);
    const encoded = encodeSignedTx(envelope);

    const result = await submit(encoded, txId);

    return {
      ok: true,
      txId,
      // Submitted is all this knows. A caller rendering "confirmed" from this value
      // is claiming something this function cannot establish.
      state: 'submitted',
      bytes: encoded.length,
      result,
    };
  } finally {
    // Drop the plaintext regardless of outcome, including on a throw. A phrase that
    // outlives the call it was decrypted for is the failure this module exists to
    // prevent.
    phrase = null;
  }
}
