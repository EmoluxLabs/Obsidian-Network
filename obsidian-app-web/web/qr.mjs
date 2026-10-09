/**
 * QR codes for the wallet: draw an address, read one.
 *
 * Two small libraries do the heavy lifting and are bundled into the browser build —
 * `qrcode-generator` (MIT) to encode and `jsqr` (Apache-2.0) to decode. Nothing here is
 * novel cryptography; what this file adds is the part that is easy to get wrong:
 * deciding what a scanned code is allowed to mean.
 *
 * What the QR carries: the bare address, nothing else. No amount, no memo, no URI.
 * A bare address is what every other scanner and wallet understands, and a code that
 * could pre-fill an amount is a code that could be made to pre-fill someone else's.
 *
 * What a scan may do: fill in the RECIPIENT field and nothing more. It never submits,
 * never touches the amount, and an address that does not belong to this network is
 * refused here, before the user can send coins somewhere that chain cannot reach.
 */

import qrcode from 'qrcode-generator';
import jsQR from 'jsqr';
import { isValidAddress } from '../../obsidian-interface/web/core/crypto/keys.js';

/** Every address prefix an Obsidian network uses. */
const NETWORK_OF_HRP = { obs: 'mainnet', tobs: 'testnet', sobs: 'staging', dobs: 'devnet' };

/**
 * The code as a grid of booleans (true = dark). Error correction M (~15 %) is what a
 * phone camera pointed at a screen needs; the version is the smallest that fits.
 */
export function qrModules(text) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text));
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/**
 * The code as an SVG string. Dark modules are one path, on a white square with the
 * four-module quiet zone the QR standard asks for, so it scans on any page background.
 */
export function qrSvg(text, label = 'QR code') {
  const modules = qrModules(text);
  const quiet = 4;
  const size = modules.length + quiet * 2;
  let d = '';
  modules.forEach((row, r) =>
    row.forEach((dark, c) => {
      if (dark) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }),
  );
  const safe = String(label).replace(/[&<>"']/g, '');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${safe}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
  );
}

/** Decode a QR from raw pixels ({ data: RGBA, width, height }); the text, or null. */
export function decodeQr(image) {
  const found = jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' });
  return found?.data ?? null;
}

/**
 * What a scanned string means for THIS wallet.
 *
 * `{ ok: true, kind: 'address', value }` — a valid address on this network.
 * `{ ok: true, kind: 'name', value }`    — a `.obs` name (resolved by the node when sent).
 * `{ ok: false, message }`               — anything else, said plainly.
 *
 * An address is checked with its checksum, not just its shape, so a code that was
 * misread or tampered with is refused rather than filled in. A scan of this wallet's
 * own address is refused too: it is almost always a mistake, and a payment to yourself
 * is just gas lost.
 */
export function readScanned(raw, { hrp, own } = {}) {
  let text = String(raw ?? '').trim();
  if (!text) return { ok: false, message: 'That code is empty.' };
  // Tolerate a scheme some wallets add ("obsidian:dobs1…") but ignore anything after.
  text = text.replace(/^obsidian:/i, '').split(/[?#\s]/)[0].trim();

  const lower = text.toLowerCase();
  if (/^[a-z0-9][a-z0-9-]{0,62}\.obs$/.test(lower)) return { ok: true, kind: 'name', value: lower };

  const prefix = /^(obs|tobs|sobs|dobs)1[0-9a-z]+$/.exec(lower)?.[1];
  if (!prefix) return { ok: false, message: 'That is not an Obsidian address. Scan a wallet’s RECEIVE code.' };
  if (hrp && prefix !== hrp) {
    return {
      ok: false,
      message: `That is a ${NETWORK_OF_HRP[prefix]} address (${prefix}1…), and this is the ${NETWORK_OF_HRP[hrp] ?? hrp} app (${hrp}1…). Coins sent there would never arrive.`,
    };
  }
  if (!isValidAddress(lower, prefix)) {
    return { ok: false, message: 'That address fails its checksum, so the code was misread or altered. Try again.' };
  }
  if (own && lower === String(own).toLowerCase()) {
    return { ok: false, message: 'That is your own address. Scan the code of the wallet you want to pay.' };
  }
  return { ok: true, kind: 'address', value: lower };
}
