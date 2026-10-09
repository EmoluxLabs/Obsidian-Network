/**
 * Wallet QR codes: the code drawn on RECEIVE, and what a scan on SEND may mean.
 *
 * The round trip is the test that matters. A QR that merely looks like a QR proves
 * nothing, so every code drawn here is rasterised and read back with the same decoder
 * the scanner uses, and must come back as exactly the address it was drawn for.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { qrModules, qrSvg, decodeQr, readScanned } from '../web/qr.mjs';
import { walletFromPhrase } from '../web/signing.mjs';
import { cameraMessage } from '../public/scanner.mjs';
import { rasterise, modulesFromSvg } from './helpers/qr-raster.mjs';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ADDRESS = { obs: 'mainnet', tobs: 'testnet', sobs: 'staging', dobs: 'devnet' };
const addr = (hrp, phrase = PHRASE) => walletFromPhrase(phrase, hrp).address;

test('an address drawn as a QR reads back as exactly that address, on every network', () => {
  for (const hrp of Object.keys(ADDRESS)) {
    const address = addr(hrp);
    assert.equal(decodeQr(rasterise(qrModules(address))), address, `${hrp}: round trip`);
  }
});

test('the SVG that is displayed decodes to the address, not just the encoder behind it', () => {
  for (const hrp of ['obs', 'dobs']) {
    const address = addr(hrp);
    const svg = qrSvg(address, `Obsidian address ${address}`);
    assert.equal(decodeQr(rasterise(modulesFromSvg(svg))), address);
  }
});

test('it still reads at a small size and when light and dark are swapped', () => {
  const address = addr('dobs');
  assert.equal(decodeQr(rasterise(qrModules(address), 3)), address, 'small');
  assert.equal(decodeQr(rasterise(qrModules(address), 6, 4, true)), address, 'inverted');
});

test('the SVG is inert: no script, no external reference, white background, labelled', () => {
  const svg = qrSvg(addr('dobs'), 'Obsidian address <x>"&');
  assert.match(svg, /^<svg [^>]*role="img" aria-label="Obsidian address x"/, 'the label is sanitised');
  assert.doesNotMatch(svg, /<script|href=|onload|javascript:|<image|<foreignObject/i);
  assert.match(svg, /<rect [^>]*fill="#fff"/, 'a white ground, so it scans on any background');
});

test('the code carries the bare address and nothing else', () => {
  const address = addr('dobs');
  const read = decodeQr(rasterise(qrModules(address)));
  assert.equal(read, address);
  assert.doesNotMatch(read, /amount|memo|:|\?/);
});

// ── what a scan may mean ─────────────────────────────────────────────────────

const HRP = 'dobs';
const mine = addr('dobs');

test('a valid address on this network is accepted', () => {
  // A second phrase's address, so it is not the wallet's own.
  const other = walletFromPhrase('legal winner thank year wave sausage worth useful legal winner thank yellow', HRP).address;
  assert.deepEqual(readScanned(other, { hrp: HRP, own: mine }), { ok: true, kind: 'address', value: other });
});

test('a scan is trimmed, lower-cased and stripped of a scheme or trailing query', () => {
  const other = walletFromPhrase('legal winner thank year wave sausage worth useful legal winner thank yellow', HRP).address;
  for (const raw of [`  ${other}\n`, other.toUpperCase(), `obsidian:${other}`, `OBSIDIAN:${other}?amount=999&memo=hi`, `${other}#x`]) {
    const got = readScanned(raw, { hrp: HRP, own: mine });
    assert.equal(got.ok, true, raw);
    assert.equal(got.value, other, 'only the address survives: an amount in a code is ignored');
  }
});

test('an address from another network is refused, and the message says which', () => {
  for (const hrp of ['obs', 'tobs', 'sobs']) {
    const got = readScanned(addr(hrp), { hrp: HRP, own: mine });
    assert.equal(got.ok, false);
    assert.match(got.message, new RegExp(ADDRESS[hrp]));
    assert.match(got.message, /devnet app/);
  }
  // And the same code is fine in the app it belongs to.
  assert.equal(readScanned(addr('obs', 'legal winner thank year wave sausage worth useful legal winner thank yellow'), { hrp: 'obs' }).ok, true);
});

test('a misread or altered address fails its checksum and is refused', () => {
  const other = walletFromPhrase('legal winner thank year wave sausage worth useful legal winner thank yellow', HRP).address;
  const flipped = other.slice(0, -1) + (other.endsWith('q') ? 'p' : 'q');
  const got = readScanned(flipped, { hrp: HRP, own: mine });
  assert.equal(got.ok, false);
  assert.match(got.message, /checksum/);
});

test('your own address is refused', () => {
  const got = readScanned(mine, { hrp: HRP, own: mine });
  assert.equal(got.ok, false);
  assert.match(got.message, /your own address/);
});

test('a .obs name is accepted as a name', () => {
  assert.deepEqual(readScanned('Alice.OBS', { hrp: HRP }), { ok: true, kind: 'name', value: 'alice.obs' });
});

test('anything else is refused plainly: a URL, text, a number, nothing', () => {
  for (const raw of ['https://example.com/pay?to=x', 'hello', '12345', '', '   ', null, undefined, 'dobs1', 'dobs1!!!!', 'bitcoin:bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh']) {
    const got = readScanned(raw, { hrp: HRP, own: mine });
    assert.equal(got.ok, false, String(raw));
    assert.ok(got.message.length > 10);
  }
});

test('camera failures are explained in terms of what to do next', () => {
  assert.match(cameraMessage({ name: 'NotAllowedError' }), /permission.*photo/i);
  assert.match(cameraMessage({ name: 'NotFoundError' }), /No camera.*photo/i);
  assert.match(cameraMessage({ name: 'NotReadableError' }), /in use.*photo/i);
  assert.match(cameraMessage({ name: 'NoSecureContext' }), /https.*photo/i);
  assert.match(cameraMessage(new Error('x')), /photo/i);
});

test('jsQR is the decoder in play, and finds nothing in a blank image', () => {
  const blank = { data: new Uint8ClampedArray(100 * 100 * 4).fill(255), width: 100, height: 100 };
  assert.equal(decodeQr(blank), null);
  assert.equal(typeof jsQR, 'function');
});
