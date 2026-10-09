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
 *
 * Nothing here talks to the network. Signing is not submitting: this module turns
 * protocol values into signature bytes and hands them back. Whether, when and where
 * those bytes are sent is the caller's decision, and a signature is not a
 * confirmation.
 */

import {
  deriveWallet,
  generateRecoveryPhrase,
  isValidRecoveryPhrase,
} from '../../obsidian-interface/web/core/crypto/mnemonic.js';
import { addressFromPublicKey, signMessage } from '../../obsidian-interface/web/core/crypto/keys.js';
import { encodePayload, decodePayload } from '../../obsidian-interface/web/core/crypto/bech32.js';
import {
  signTransaction,
  encodeSignedTx,
  signingDigest,
  txIdOf,
} from '../../obsidian-interface/web/core/transactions/encode.js';
import { TxType, OnsOp } from '../../obsidian-interface/web/core/protocol/types.js';
import { PROTOCOL_VERSION } from '../../obsidian-interface/web/core/version.js';
import { encodeMiningBody } from '../../obsidian-interface/web/core/transactions/executors/mining.js';
import { encodePaymentBody } from '../../obsidian-interface/web/core/transactions/executors/payment.js';
import { encodeOnsBody } from '../../obsidian-interface/web/core/transactions/executors/ons.js';
import { expectedGas } from '../../obsidian-interface/web/core/transactions/helpers.js';

/**
 * A new 24-word recovery phrase, from the canonical generator (256 bits of entropy,
 * the platform's own choice). The randomness is the browser's CSPRNG; nothing here
 * stores, sends or logs the result — that is the caller's to hold in memory and seal.
 */
export function generatePhrase() {
  return generateRecoveryPhrase();
}

/** True for a phrase the canonical BIP-39 word list accepts. */
export function isValidPhrase(phrase) {
  return isValidRecoveryPhrase(String(phrase ?? '').trim());
}

/**
 * Recover a wallet from its phrase.
 *
 * The phrase is used here and nowhere else. It is never sent to the platform, never
 * written to storage, and never logged. `deriveWallet` is the canonical derivation,
 * so the address this produces is the same one the node and the web platform derive
 * from the same words — which is the whole point of not writing a second one.
 */
export function walletFromPhrase(phrase, hrp) {
  const words = String(phrase ?? '').trim();
  if (!isValidRecoveryPhrase(words)) {
    throw new Error('That recovery phrase is not valid.');
  }
  // The address prefix belongs to the NETWORK, not to the phrase: obs on mainnet,
  // tobs on testnet, sobs on staging, dobs on devnet. The same words give the same
  // key everywhere and a different bech32 string on each chain, and a node refuses
  // an address whose prefix is not its own with ERR_BAD_ADDRESS. So the prefix is
  // the node's to state (/network -> addressHrp) and is passed in; nothing here
  // guesses it. Left undefined, the canonical default (mainnet) applies.
  if (hrp !== undefined && !(typeof hrp === 'string' && /^[a-z]{2,10}$/.test(hrp))) {
    throw new Error('the node reported an unusable address prefix');
  }
  // Indices are passed explicitly rather than left to the default, matching how the
  // web platform calls it. A derivation that silently depends on a default is one
  // upstream change away from producing a different key for the same words, which is
  // the exact failure mode the platform's own wallet.ts documents.
  const wallet = deriveWallet(words, 0, 0, undefined, hrp);
  // The wallet object exposes `privateKey`, not `privateKeyHex`, and carries its own
  // `address`. Reading the names it actually has rather than the ones that sound
  // right is what the signing vector enforces.
  return {
    address: wallet.address ?? addressFromPublicKey(wallet.publicKey, hrp),
    publicKey: wallet.publicKey,
    privateKeyHex: wallet.privateKey,
  };
}

/**
 * Re-express an address under another network's prefix.
 *
 * An address is a prefix plus a checksummed 20-byte payload. Changing the prefix
 * changes the checksum but not the payload, so a cached `obs1…` address can become
 * its `dobs1…` twin without the phrase, and therefore without asking for the
 * passphrase. Used when the node the app is pointed at is on a different network
 * from the one the address was cached under.
 */
export function retargetAddress(address, hrp) {
  const text = String(address ?? '');
  const split = text.lastIndexOf('1');
  if (split < 1) throw new Error('not a bech32 address');
  const payload = decodePayload(text.slice(0, split), text);
  return encodePayload(hrp, payload);
}

/**
 * Sign one transaction and return the bytes to submit.
 *
 * Every protocol value here — chainId, protocolVersion, nonce, gas, validUntil — is
 * supplied by the caller from the node. Nothing is defaulted in this file, because a
 * wrong chainId produces a signature every node on the real network will refuse, and
 * a defaulted nonce invites a replay. `gas` is not even allowed to arrive as
 * `undefined`: the encoder writes it as a u128 and would throw somewhere far from the
 * mistake that caused it.
 */
export function sign({ wallet, chainId, protocolVersion, nonce, type, gas, body, memo, validUntil }) {
  if (!wallet?.address || !wallet?.privateKeyHex || !wallet?.publicKey) {
    throw new Error('a wallet with an address, a public key and a private key is required');
  }
  if (!Number.isInteger(chainId)) throw new Error('chainId must be an integer');
  if (!protocolVersion) throw new Error('protocolVersion is required');
  if (!Number.isInteger(nonce) || nonce < 0) throw new Error('nonce must be a non-negative integer');
  if (typeof gas !== 'bigint') throw new Error('gas must be a bigint (use 0n for a free transaction)');
  if (!(body instanceof Uint8Array)) throw new Error('body must be a Uint8Array');
  if (!Number.isFinite(validUntil)) throw new Error('validUntil must be a number');

  const envelope = signTransaction({
    sender: wallet.address,
    privateKeyHex: wallet.privateKeyHex, // from walletFromPhrase above
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

  const bytes = encodeSignedTx(envelope);
  return {
    envelope,
    bytes,
    // The envelope carries `id`, and txIdOf reads it. Computing a second id from
    // a field that does not exist (`unsigned`) would yield `undefined`, which is
    // how a UI ends up showing a transaction id for a transaction it never named.
    txId: txIdOf(envelope),
    hex: toHex(bytes),
  };
}

/**
 * The domain tag of the wallet-link proof. It is fixed HERE, in the client, and the server's
 * copy is only ever compared against it: a server must not be able to choose the domain a user
 * signs under, so a link proof can never be passed off as a transaction signature.
 */
export const WALLET_LINK_DOMAIN = 'OBSIDIAN:WALLET_LINK:v1';

/**
 * Sign the platform's wallet-link challenge with the wallet's own key.
 *
 * This proves the device holds the key for the address, which is what lets the platform bind
 * the address to the account for good without ever holding a key or deriving one from the
 * account. The message must be a link challenge for exactly this wallet's address; anything
 * else is refused before a key touches it.
 */
export function signLinkChallenge({ wallet, message }) {
  if (!wallet?.address || !wallet?.privateKeyHex || !wallet?.publicKey) {
    throw new Error('a wallet with an address, a public key and a private key is required');
  }
  const text = String(message ?? '');
  const lines = text.split('\n');
  if (lines[0] !== 'OBSIDIAN WALLET LINK v1' || !lines.includes(`address: ${wallet.address}`)) {
    throw new Error('that is not a link challenge for this wallet, so it was not signed');
  }
  return {
    address: wallet.address,
    publicKey: wallet.publicKey,
    signature: signMessage(WALLET_LINK_DOMAIN, new TextEncoder().encode(text), wallet.privateKeyHex),
  };
}

/**
 * The digest a transaction will be signed over.
 *
 * Exposed so the UI can show the user exactly what they are about to sign before a
 * key touches it. A signature the user cannot inspect is not consent.
 */
export function signingDigestFor(unsigned) {
  return signingDigest(unsigned);
}

// ── transaction bodies ───────────────────────────────────────────────────────
// Each one is the canonical encoder of its executor. Rewriting any of them here is
// how a body stops matching what the node decodes.

/**
 * A MINING_CLAIM body.
 *
 * `claimId` is not chosen by this app: the node computes it from the chain id, the
 * address, the claim sequence and the last claim height, and publishes it on
 * /mining/status as `nextClaimId`. Inventing one locally produces a body every node
 * refuses with MINING_BAD_PROOF.
 *
 * `gate` (protocol 1.7.0) is the certificate the account platform issued for this wallet and this claim id:
 * `{ issuer, issuedAt, signature }`. Without it every node refuses the claim (MINING_GATE_REQUIRED).
 */
export function buildMiningBody({ claimId, claimSequence, viaNodeId, gate }) {
  return encodeMiningBody({ claimId, claimSequence, viaNodeId: viaNodeId ?? '', gate });
}

/** A PAYMENT body. `amount` is in seals, not OBS. */
export function buildPaymentBody({ to, amount, memo }) {
  if (typeof amount !== 'bigint') throw new Error('amount must be a bigint of seals');
  return encodePaymentBody({ to, amount, memo: memo || '' });
}

/** An ONS body — register, renew, transfer or repoint a name. */
export function buildOnsBody({ op, name, address, to, fee }) {
  return encodeOnsBody({
    op,
    name,
    address: address ?? '',
    to: to ?? '',
    fee: typeof fee === 'bigint' ? fee : 0n,
  });
}

function toHex(bytes) {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export { TxType, OnsOp, PROTOCOL_VERSION, expectedGas };
