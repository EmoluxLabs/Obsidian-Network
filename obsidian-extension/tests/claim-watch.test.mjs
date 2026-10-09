import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateClaim } from '../src/claim-watch.mjs';

const ADDRESS = 'dobs1m6927qpu49ke2gz6jqerl42c8a86k73pqfzhsk';
const settings = (over = {}) => ({ serverUrl: 'https://x.org', network: 'devnet', alerts: true, address: ADDRESS, ...over });
const config = { network: 'devnet', networkId: 'obsidian-devnet-1', chainId: 7780, addressHrp: 'dobs', verified: true, verification: 'ok' };
const mining = (over = {}) => ({ address: ADDRESS, eligible: true, nextClaimSequence: 3, cycleStartAt: 100, nextEligibleAt: 5, ...over });

function server({ appConfig = config, status = mining(), failApp, failStatus } = {}) {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url.replace('https://x.org', ''));
    if (url.endsWith('/app-config.json')) {
      if (failApp) throw new TypeError('down');
      return { ok: true, status: 200, text: async () => JSON.stringify(appConfig) };
    }
    if (failStatus) return { ok: false, status: 502, text: async () => '{}' };
    return { ok: true, status: 200, text: async () => JSON.stringify(status) };
  };
  return { fetchImpl, seen };
}

test('alerts off / not configured / no wallet: nothing is asked of anyone', async () => {
  const s = server();
  assert.equal((await evaluateClaim(settings({ alerts: false }), s)).state, 'off');
  assert.equal((await evaluateClaim(settings({ serverUrl: null }), s)).state, 'not-configured');
  assert.equal((await evaluateClaim(settings({ network: null }), s)).state, 'not-configured');
  assert.equal((await evaluateClaim(settings({ address: null }), s)).state, 'no-wallet');
  assert.deepEqual(s.seen, []);
});

test('an address from another network is never sent anywhere', async () => {
  const s = server();
  const r = await evaluateClaim(settings({ address: 'obs1m6927qpu49ke2gz6jqerl42c8a86k73pqfzhsk' }), s);
  assert.equal(r.state, 'wrong-network');
  assert.deepEqual(s.seen, []);
});

test('eligible per the node: notify once per claim opportunity', async () => {
  const first = await evaluateClaim(settings(), server());
  assert.equal(first.state, 'eligible');
  assert.equal(first.notify, true);
  const again = await evaluateClaim(settings(), { ...server(), lastNotified: first.windowKey });
  assert.equal(again.state, 'eligible');
  assert.equal(again.notify, false, 'not repeated every minute');
  const next = await evaluateClaim(settings(), { ...server({ status: mining({ nextClaimSequence: 4 }) }), lastNotified: first.windowKey });
  assert.equal(next.notify, true, 'a new opportunity alerts again');
});

test('not eligible per the node: waiting, no notification; the extension never decides eligibility itself', async () => {
  const r = await evaluateClaim(settings(), server({ status: mining({ eligible: false, nextEligibleAt: 99 }) }));
  assert.equal(r.state, 'waiting');
  assert.equal(r.notify, false);
  // A truthy-but-not-true value is not "eligible".
  for (const eligible of ['true', 1, 'yes', null, undefined]) {
    const x = await evaluateClaim(settings(), server({ status: mining({ eligible }) }));
    assert.equal(x.notify, false, String(eligible));
    assert.equal(x.state, 'unavailable');
  }
});

test('an answer about a different address is rejected', async () => {
  const r = await evaluateClaim(settings(), server({ status: mining({ address: 'dobs1other' }) }));
  assert.equal(r.state, 'unavailable');
  assert.equal(r.notify, false);
});

test('wrong-network server, unverified server, unreachable server, failing node: never a notification', async () => {
  assert.equal((await evaluateClaim(settings(), server({ appConfig: { ...config, network: 'testnet', networkId: 'obsidian-testnet-1', chainId: 7778, addressHrp: 'tobs' } }))).state, 'wrong-network');
  assert.equal((await evaluateClaim(settings(), server({ appConfig: { ...config, verified: false } }))).state, 'unavailable');
  assert.equal((await evaluateClaim(settings(), server({ failApp: true }))).state, 'unavailable');
  const failing = await evaluateClaim(settings(), server({ failStatus: true }));
  assert.equal(failing.state, 'unavailable');
  assert.equal(failing.notify, false);
});

test('it asks the node about this address and no other', async () => {
  const s = server();
  await evaluateClaim(settings(), s);
  assert.equal(s.seen.length, 2);
  assert.equal(s.seen[1], '/api/rpc?path=' + encodeURIComponent(`/mining/status?address=${ADDRESS}`));
});
