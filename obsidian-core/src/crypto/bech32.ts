/**
 * Bech32 / Bech32m reference implementation (BIP-0173 / BIP-0350).
 *
 * Obsidian uses bech32 (not bech32m) with human-readable part "obs" for wallet
 * addresses, and bech32m for on-chain name / parcel / capsule identifiers.
 * This is a well-specified public encoding, not a bespoke primitive: the
 * payload is always the SHA-256/RIPEMD-160 digest of a secp256k1 public key.
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const CHARSET_MAP = new Map<string, number>(CHARSET.split('').map((c, i) => [c, i]));

export const BECH32_CONST = 1;
export const BECH32M_CONST = 0x2bc830a3;

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i += 1) {
      if (((top >> i) & 1) === 1) chk ^= GEN[i];
    }
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i += 1) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i += 1) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function createChecksum(hrp: string, data: number[], encoding: number): number[] {
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ encoding;
  const out: number[] = [];
  for (let i = 0; i < 6; i += 1) out.push((mod >> (5 * (5 - i))) & 31);
  return out;
}

function verifyChecksum(hrp: string, data: number[]): number {
  return polymod([...hrpExpand(hrp), ...data]);
}

export function convertBits(data: number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const ret: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) throw new Error('bech32: invalid data range');
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) ret.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    throw new Error('bech32: invalid padding');
  }
  return ret;
}

export function bech32Encode(hrp: string, data: number[], encoding = BECH32_CONST): string {
  const combined = [...data, ...createChecksum(hrp, data, encoding)];
  return `${hrp}1${combined.map((d) => CHARSET[d]).join('')}`;
}

export function bech32Decode(
  str: string,
  expectedEncoding?: number,
): { hrp: string; data: number[]; encoding: number } {
  if (str.length > 500) throw new Error('bech32: string too long');
  if (str.length < 8) throw new Error('bech32: string too short');
  const lowered = str.toLowerCase();
  if (str !== lowered && str !== str.toUpperCase()) throw new Error('bech32: mixed case');
  const str2 = lowered;
  const pos = str2.lastIndexOf('1');
  if (pos < 1 || pos + 7 > str2.length) throw new Error('bech32: invalid separator position');
  const hrp = str2.slice(0, pos);
  for (const c of hrp) {
    if (c.charCodeAt(0) < 33 || c.charCodeAt(0) > 126) throw new Error('bech32: invalid HRP char');
  }
  const data: number[] = [];
  for (const c of str2.slice(pos + 1)) {
    const v = CHARSET_MAP.get(c);
    if (v === undefined) throw new Error(`bech32: invalid character ${c}`);
    data.push(v);
  }
  const checksum = verifyChecksum(hrp, data);
  if (checksum !== BECH32_CONST && checksum !== BECH32M_CONST) throw new Error('bech32: bad checksum');
  if (expectedEncoding !== undefined && checksum !== expectedEncoding) {
    throw new Error('bech32: unexpected checksum variant');
  }
  return { hrp, data: data.slice(0, -6), encoding: checksum };
}

export function encodePayload(hrp: string, payload: Uint8Array, encoding = BECH32_CONST): string {
  return bech32Encode(hrp, convertBits(Array.from(payload), 8, 5, true), encoding);
}

export function decodePayload(hrp: string, str: string, encoding = BECH32_CONST): Uint8Array {
  const { hrp: gotHrp, data } = bech32Decode(str, encoding);
  if (gotHrp !== hrp) throw new Error(`bech32: unexpected HRP "${gotHrp}", expected "${hrp}"`);
  return new Uint8Array(convertBits(data, 5, 8, false));
}
