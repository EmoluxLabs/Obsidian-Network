/**
 * The app's browser entry point.
 *
 * Bundled with esbuild at --platform=browser, which makes the build FAIL if
 * anything on this path imports a Node built-in. That is the guarantee the wallet
 * depends on: if the bundle builds, nothing in it can reach the filesystem, spawn a
 * process, or quietly pull in a server-only module.
 *
 * The crypto imported here is the canonical implementation, synced from
 * obsidian-core by scripts/sync-core.mjs — the same encoders, the same signature
 * scheme and the same address derivation the node uses. This file adds no second
 * derivation path. If a function needed here is missing from web/core, the right
 * answer is to widen the sync, never to reimplement it.
 */

import { deriveWallet, isValidRecoveryPhrase } from '../../obsidian-interface/web/core/crypto/mnemonic.js';
import { addressFromPublicKey } from '../../obsidian-interface/web/core/crypto/keys.js';
import { signTransaction, encodeSignedTx, signingDigest } from '../../obsidian-interface/web/core/transactions/encode.js';
import { TxType } from '../../obsidian-interface/web/core/protocol/types.js';

/**
 * Recover a wallet from its phrase.
 *
 * The phrase is used here and nowhere else. It is never sent to the platform, never
 * written to storage, and never logged. `deriveWallet` is the canonical derivation,
 * so the address this produces is the same one the node and the web platform derive
 * from the same words — which is the whole point of not writing a second one.
 */
export function walletFromPhrase(phrase) {
  if (!isValidRecoveryPhrase(phrase)) {
    throw new Error('That recovery phrase is not valid.');
  }
  // Indices are passed explicitly rather than left to the default, matching how the
  // web platform calls it. Verified that the defaults currently produce the same
  // key - but a derivation that silently depends on a default is one upstream
  // change away from producing a different key for the same words, which is the
  // exact failure mode the platform's own wallet.ts documents.
  const wallet = deriveWallet(phrase.trim(), 0, 0);
  return {
    address: addressFromPublicKey(wallet.publicKey),
    publicKey: wallet.publicKey,
    privateKeyHex: wallet.privateKeyHex,
  };
}

/**
 * Sign one transaction and return the bytes to submit.
 *
 * Every protocol value here — chainId, protocolVersion, nonce, gas, validUntil — is
 * supplied by the caller from the node. Nothing is defaulted in this file, because a
 * wrong chainId produces a signature every node on the real network will refuse, and
 * a defaulted nonce invites a replay.
 *
 * Signing is not submitting. The caller decides when to send these bytes, and
 * acceptance into a mempool is still not a confirmation.
 */
export function sign({ wallet, chainId, protocolVersion, nonce, type, gas, body, memo, validUntil }) {
  const envelope = signTransaction({
    sender: wallet.address,
    privateKeyHex: wallet.privateKeyHex,
    publicKeyHex: wallet.publicKey,
    chainId,
    protocolVersion,
    nonce,
    type,
    gas,
    body,
    memo,
    validUntil,
  });
  return {
    envelope,
    bytes: encodeSignedTx(envelope),
    txId: envelope.txId ?? null,
  };
}

/**
 * The digest a MINING_CLAIM will be signed over.
 *
 * Exposed so the UI can show the user exactly what they are about to sign before a
 * key touches it. A signature the user cannot inspect is not consent.
 */
export function claimDigest(unsigned) {
  return signingDigest(unsigned);
}

export { TxType };
