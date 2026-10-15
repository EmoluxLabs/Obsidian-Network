/**
 * Private-key recovery: turn what a person pasted into a key, or into a precise refusal.
 *
 * The recovery phrase and the private key are two ways to hold the SAME wallet: the key shown at creation is the
 * secp256k1 key the phrase derives at account 0, index 0 (see mnemonic.ts), and its address comes from the same
 * `keyPairFromPrivateKey` the node uses. Nothing here is a second derivation.
 *
 * Accepted: exactly 32 bytes as 64 hex digits, either case, optionally with a `0x` prefix and surrounding whitespace.
 * Refused, each with its own reason (and NEVER echoing the input back, because the input may be a real secret that
 * will end up in a log, a screenshot or an error report otherwise):
 *   - empty input
 *   - a recovery phrase (several words): use phrase recovery instead
 *   - a public key (33 or 65 bytes): it cannot sign
 *   - any other length, or non-hex characters (WIF, base64, bech32 and the like are not supported)
 *   - 0 and values at or above the curve order, which are not private keys
 */
import { keyPairFromPrivateKey, isValidPrivateKey, ADDRESS_HRP } from './keys.js';
import { fromHex } from './hash.js';

export type PrivateKeyProblem =
  | 'EMPTY'
  | 'LOOKS_LIKE_PHRASE'
  | 'LOOKS_LIKE_PUBLIC_KEY'
  | 'WRONG_LENGTH'
  | 'NOT_HEX'
  | 'NOT_A_VALID_KEY';

export type PrivateKeyParse =
  | { ok: true; privateKey: string }
  | { ok: false; code: PrivateKeyProblem; message: string };

const MESSAGES: Record<PrivateKeyProblem, string> = {
  EMPTY: 'Enter your private key.',
  LOOKS_LIKE_PHRASE: 'That looks like a recovery phrase, not a private key. Use recovery with the phrase instead.',
  LOOKS_LIKE_PUBLIC_KEY: 'That looks like a public key. A public key cannot recover a wallet; you need the private key.',
  WRONG_LENGTH: 'A private key is exactly 64 hexadecimal characters (32 bytes). This one is not that length.',
  NOT_HEX: 'A private key uses only the digits 0–9 and the letters a–f. Other encodings are not supported.',
  NOT_A_VALID_KEY: 'That is not a valid private key for this network’s curve.',
};

const refuse = (code: PrivateKeyProblem): PrivateKeyParse => ({ ok: false, code, message: MESSAGES[code] });

/** Validate pasted text locally. Pure: no storage, no network, no logging. */
export function parsePrivateKeyInput(input: unknown): PrivateKeyParse {
  if (typeof input !== 'string') return refuse('EMPTY');
  let text = input.normalize('NFKC').trim();
  if (text.length === 0) return refuse('EMPTY');
  if (/\s/.test(text)) return refuse('LOOKS_LIKE_PHRASE');
  if (/^0x/i.test(text)) text = text.slice(2);
  if (text.length === 0) return refuse('EMPTY');
  if (!/^[0-9a-fA-F]+$/.test(text)) return refuse('NOT_HEX');
  if (text.length === 66 && /^0[23]/.test(text)) return refuse('LOOKS_LIKE_PUBLIC_KEY');
  if (text.length === 130 && /^04/.test(text)) return refuse('LOOKS_LIKE_PUBLIC_KEY');
  if (text.length !== 64) return refuse('WRONG_LENGTH');
  const lower = text.toLowerCase();
  if (!isValidPrivateKey(fromHex(lower))) return refuse('NOT_A_VALID_KEY');
  return { ok: true, privateKey: lower };
}

/** The wallet a pasted private key controls, for the confirmation step ("is this your address?"). */
export function walletFromPrivateKeyInput(
  input: unknown,
  addressHrp: string = ADDRESS_HRP,
): { ok: true; address: string; publicKey: string; privateKey: string } | { ok: false; code: PrivateKeyProblem; message: string } {
  const parsed = parsePrivateKeyInput(input);
  if (!parsed.ok) return parsed;
  const pair = keyPairFromPrivateKey(parsed.privateKey, addressHrp);
  return { ok: true, address: pair.address, publicKey: pair.publicKey, privateKey: pair.privateKey };
}
