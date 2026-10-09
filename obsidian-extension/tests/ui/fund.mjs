// Test-only helpers that use obsidian-core directly: make a disposable recovery phrase and its address, and read the
// node's own RPC to cross-check what the extension shows. Nothing here is part of the extension.
import { pathToFileURL } from 'node:url';
import { createHmac } from 'node:crypto';

const core = new URL('../../../obsidian-core/dist/', import.meta.url).pathname;
const imp = (p) => import(pathToFileURL(core + p).href);

export async function disposableWallet(hrp = 'dobs') {
  const mnemonic = await imp('crypto/mnemonic.js');
  const phrase = mnemonic.generateRecoveryPhrase();
  const wallet = mnemonic.deriveWallet(phrase, 0, 0, undefined, hrp);
  return { phrase, address: wallet.address };
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** RFC 6238 (SHA-1, 30 s, 6 digits) from a base32 secret, as an authenticator app computes it. */
export function totp(secret, at = Date.now()) {
  let bits = '';
  for (const c of secret.replace(/[\s=]/g, '').toUpperCase()) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const o = mac[19] & 15;
  const n = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

export const rpc = async (node, path) => (await fetch(node + path)).json();
