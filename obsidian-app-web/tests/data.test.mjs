/**
 * The data layer, with fetch stubbed.
 *
 * Two classes of bug live here, and neither is visible on screen:
 *
 *   - a wrong URL. The platform proxies node reads at `/api/rpc?path=<route>` —
 *     a PATH proxy, not JSON-RPC. This file once posted a `{"jsonrpc":"2.0",
 *     "method":"getstatus"}` envelope at it, and every chain read answered
 *     "not found" while the app looked like it was working.
 *   - a wrong unit. The protocol's base unit is the seal and 1 OBS is 10^18 of
 *     them. Dividing by 10^8 — which this file also once did — overstates every
 *     balance and every reward by ten orders of magnitude, and renders as a number
 *     large enough that nobody questions it.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  sealsToObs,
  parseObs,
  formatDuration,
  formatTerm,
  formatTime,
  normaliseName,
  getMiningStatus,
  getBalance,
  getNextNonce,
  getBlocks,
  getName,
  submitTransaction,
  getStatus,
} from '../public/data.mjs';

let calls = [];
let responder = async () => ({ ok: true, status: 200, text: async () => '{}' });

beforeEach(() => {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    return responder(url, init);
  };
});

afterEach(() => {
  delete globalThis.fetch;
});

function lastCall() {
  return calls[calls.length - 1];
}

// ── amounts ──────────────────────────────────────────────────────────────────

test('one OBS is 10^18 seals, not 10^8', () => {
  assert.equal(sealsToObs(10n ** 18n), '1');
  assert.equal(sealsToObs(String(10n ** 18n)), '1');
  // The regression, in one line: the 10^8 version of this function rendered a
  // single OBS as ten billion of them.
  assert.notEqual(sealsToObs(10n ** 18n), '10000000000');
  assert.equal(sealsToObs(25n * 10n ** 18n), '25');
});

test('seal amounts are formatted with BigInt, so precision is never lost', () => {
  // A balance far past 2^53: a float conversion would round it.
  const seals = 21_000_000n * 10n ** 18n;
  assert.equal(sealsToObs(seals), '21000000');
  assert.equal(sealsToObs(1n), '0');
  assert.equal(sealsToObs(1n, 18), '0.000000000000000001');
  assert.equal(sealsToObs(0n, 18), '0.000000000000000000');
  assert.equal(sealsToObs(5n * 10n ** 17n), '0.5');
});

test('an amount that is not a number renders as unavailable, never as zero', () => {
  assert.equal(sealsToObs(null), '—');
  assert.equal(sealsToObs(undefined), '—');
  assert.equal(sealsToObs('not a number'), '—');
  assert.equal(sealsToObs(-1n), '—');
});

test('parseObs is the exact inverse of sealsToObs for round amounts', () => {
  assert.equal(parseObs('0.05'), 5n * 10n ** 16n);
  assert.equal(parseObs('2'), 2n * 10n ** 18n);
  assert.equal(parseObs('0.000000000000000001'), 1n);
  assert.equal(sealsToObs(parseObs('0.05'), 18), '0.050000000000000000');
});

test('parseObs refuses what the protocol cannot represent', () => {
  assert.throws(() => parseObs('1.0000000000000000001'), /18 decimal places/);
  assert.throws(() => parseObs('-1'), /amount/);
  assert.throws(() => parseObs('1,5'), /amount/);
  assert.throws(() => parseObs(''), /amount/);
});

test('durations and times are formatted, and absent ones are marked', () => {
  assert.equal(formatDuration(14400), '4h');
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatTerm(31536000), '365 days (1 year)');
  assert.equal(formatTerm(86400 * 30), '30 days');
  assert.equal(formatTerm(14400), '4h');
  assert.equal(formatDuration(null), '0s');
  assert.equal(formatTime(0), '—');
  assert.equal(formatTime(undefined), '—');
  assert.equal(formatTime(1_700_000_000), new Date(1_700_000_000_000).toLocaleString());
});

test('a name is normalised to the chain’s own form', () => {
  assert.equal(normaliseName('Obsidian.OBS'), 'obsidian.obs');
  assert.equal(normaliseName('  my-name '), 'my-name.obs');
  assert.equal(normaliseName('ab'), null, 'too short');
  assert.equal(normaliseName('a'.repeat(25)), null, 'too long');
  assert.equal(normaliseName('bad_name'), null);
});

// ── the request the app actually sends ───────────────────────────────────────

test('node reads go through the platform’s path proxy, fully encoded', async () => {
  await getMiningStatus('obs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rxdgrkj');
  const { url, init } = lastCall();
  assert.equal(url, '/api/rpc?path=%2Fmining%2Fstatus%3Faddress%3Dobs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rxdgrkj');
  assert.equal(init.method, 'GET', 'reads are GETs');
  assert.equal(init.body, undefined);
  assert.equal(init.credentials, 'same-origin');
});

test('no request is ever a JSON-RPC envelope', async () => {
  // The regression: this file used to POST {jsonrpc, id, method, params} to
  // /api/rpc. That endpoint is a path proxy and has no methods, so every read
  // failed with "not found" behind an app that looked fine.
  await getStatus();
  await getBlocks(5);
  await getName('obsidian.obs');
  for (const { init } of calls) {
    if (!init.body) continue;
    assert.doesNotMatch(String(init.body), /jsonrpc/);
    assert.doesNotMatch(String(init.body), /"method"/);
  }
});

test('the nonce is read from its own route, for the address that will sign', async () => {
  await getNextNonce('obs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rxdgrkj');
  assert.equal(lastCall().url, '/api/rpc?path=%2Fwallet%2Fobs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rxdgrkj%2Fnext-nonce');
});

test('the balance read is a POST carrying only the address', async () => {
  await getBalance('obs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rxdgrkj');
  const { url, init } = lastCall();
  assert.equal(url, '/api/rpc?path=%2Fwallet%2Fbalance');
  assert.equal(init.method, 'POST');
  assert.deepEqual(JSON.parse(init.body), { address: 'obs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rxdgrkj' });
});

test('a submission is hex bytes under the key the node reads', async () => {
  await submitTransaction('deadbeef');
  const { url, init } = lastCall();
  assert.equal(url, '/api/rpc?path=%2Ftx%2Fsubmit');
  assert.equal(init.method, 'POST');
  assert.deepEqual(JSON.parse(init.body), { tx: 'deadbeef' });
});

test('query parameters are encoded, so an address cannot smuggle a route', async () => {
  await getMiningStatus('obs1abc?path=/metrics');
  const { url } = lastCall();
  assert.equal(url.includes('?path=/metrics'), false);
  assert.equal(url, '/api/rpc?path=%2Fmining%2Fstatus%3Faddress%3Dobs1abc%253Fpath%253D%252Fmetrics');
});

// ── error handling ───────────────────────────────────────────────────────────

test('the platform’s own error wording and code survive to the screen', async () => {
  responder = async () => ({
    ok: false,
    status: 403,
    text: async () => JSON.stringify({ error: 'that invite code has already been used', code: 'ERR_INVITE_USED' }),
  });
  await assert.rejects(getStatus(), (error) => {
    assert.equal(error.message, 'that invite code has already been used');
    assert.equal(error.code, 'ERR_INVITE_USED');
    assert.equal(error.status, 403);
    return true;
  });
});

test('a proxy that answers HTML is not mistaken for an empty chain', async () => {
  responder = async () => ({ ok: true, status: 200, text: async () => '<html>captive portal</html>' });
  await assert.rejects(getStatus(), (error) => {
    assert.match(error.message, /unexpected non-JSON response/);
    assert.equal(error.code, 'ERR_MALFORMED');
    return true;
  });
});
