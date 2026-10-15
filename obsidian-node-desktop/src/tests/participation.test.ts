import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCore } from '../core/core-loader.js';
import { createPaths } from '../core/paths.js';
import { ParticipationService } from '../core/participation-service.js';
import { parseNodeStatus, parseProducers, parseFinality, RpcError, type RpcClient } from '../core/rpc-client.js';
import { AppError } from '../shared/errors.js';
import type { NodeStatusInfo } from '../shared/chain-types.js';

async function setup(blockProduction = true) {
  const core = await loadCore();
  const base = mkdtempSync(join(tmpdir(), 'obs-participation-'));
  const paths = createPaths(base);
  const hrp = core.networks.NETWORKS.devnet.addressHrp;
  const wallet = core.keys.generateKeyPair(hrp);
  const node = core.keys.generateKeyPair(hrp);
  const np = paths.forNetwork('devnet');
  mkdirSync(np.root, { recursive: true });
  // The keystore's public part is what the app reads; the private key is never opened by this service.
  writeFileSync(np.keystore, JSON.stringify({ publicKey: node.publicKey, ciphertext: 'sealed-not-readable-here' }));
  let client: Partial<RpcClient> | null = null;
  const service = new ParticipationService({
    core: () => loadCore(),
    paths,
    settings: { get: () => ({ nodes: { devnet: { blockProduction } } }) } as never,
    rpcIfRunning: () => client as RpcClient | null,
  });
  return { core, base, paths, service, wallet, node, hrp, setClient: (c: Partial<RpcClient> | null) => (client = c) };
}

const record = (over: Partial<NodeStatusInfo> = {}): NodeStatusInfo => ({
  nodeId: 'n',
  rewardWallet: '',
  registered: true,
  bannedAtHeight: null,
  deregisteredAtHeight: null,
  registeredAtHeight: 10,
  lifetimeRewardObs: '0',
  pendingWalletChange: null,
  pendingReclaim: null,
  currentPeriod: 3,
  liveWindows: 5,
  expectedWindows: 24,
  heartbeats: 5,
  faults: 0,
  ...over,
});

const fakeNode = (rec: NodeStatusInfo | null, syncing = false): Partial<RpcClient> => ({
  health: async () => ({ height: 100, syncing }) as never,
  producers: async () => ({ tier: 'TIER1', eligible: 4, registered: 5, banned: 0, nodes: [] }),
  finality: async () => ({ available: true, finalizedHeight: 60, headHeight: 100, reason: 'ok' }) as never,
  nodeStatus: async () => rec,
});

test('binding: a valid address is saved as an address only, with no signature, key or passphrase involved', async () => {
  const s = await setup();
  const result = await s.service.bind('devnet', `  ${s.wallet.address.toUpperCase()}  `);
  assert.equal(result.rewardWallet, s.wallet.address, 'the canonical lowercase form is stored');
  assert.equal(result.appliesTo, 'next-start');
  const file = join(s.paths.forNetwork('devnet').dataDir, 'node-binding.json');
  const text = readFileSync(file, 'utf8');
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed).sort(), ['boundAt', 'rewardWallet', 'version']);
  assert.ok(!text.includes(s.wallet.privateKey) && !text.includes(s.node.privateKey), 'no private key is written');
  assert.equal(await s.service.chosenWallet('devnet'), s.wallet.address, 'the core reads back exactly what the app wrote');
});

test('binding: invalid input is refused with a reason and writes nothing', async () => {
  const s = await setup();
  const bad = [
    '',
    '   ',
    'not an address',
    s.wallet.privateKey, // a private key must never be accepted (or stored) as an address
    s.wallet.address.slice(0, -1), // truncated
    s.wallet.address.slice(0, -1) + (s.wallet.address.endsWith('q') ? 'p' : 'q'), // corrupted checksum
    s.wallet.address.replace(/^dobs1/, 'obs1'), // wrong network prefix
    '\u0000' + s.wallet.address,
  ];
  for (const input of bad) {
    await assert.rejects(s.service.bind('devnet', input), AppError, `refused: ${JSON.stringify(input).slice(0, 40)}`);
  }
  assert.ok(!existsSync(join(s.paths.forNetwork('devnet').dataDir, 'node-binding.json')), 'nothing was saved');
  assert.equal(await s.service.chosenWallet('devnet'), null);
});

test('binding: choosing again replaces the local choice atomically and leaves no temporary files', async () => {
  const s = await setup();
  const other = s.core.keys.generateKeyPair(s.hrp);
  await s.service.bind('devnet', s.wallet.address);
  await s.service.bind('devnet', other.address);
  assert.equal(await s.service.chosenWallet('devnet'), other.address);
  assert.deepEqual(readdirSync(s.paths.forNetwork('devnet').dataDir), ['node-binding.json']);
});

test('view: not running → status unknown, nothing is guessed, the identity comes from the public key only', async () => {
  const s = await setup();
  const v = await s.service.view('devnet');
  assert.equal(v.nodeReachable, false);
  assert.equal(v.phase, 'unknown');
  assert.equal(v.nodeId, s.core.keys.nodeIdFromPublicKey(s.node.publicKey));
  assert.equal(v.record, null);
  assert.equal(v.checks[0]?.pass, null, 'an unknown check is never shown as a pass');
  assert.ok(!JSON.stringify(v).includes(s.node.privateKey));
});

test('view: phases follow the chain record, not the local file', async () => {
  const s = await setup();
  s.setClient(fakeNode(null));
  assert.equal((await s.service.view('devnet')).phase, 'no-wallet');
  await s.service.bind('devnet', s.wallet.address);
  assert.equal((await s.service.view('devnet')).phase, 'waiting');
  s.setClient(fakeNode(record({ rewardWallet: s.wallet.address })));
  const registered = await s.service.view('devnet');
  assert.equal(registered.phase, 'registered');
  assert.equal(registered.chain?.finalityAvailable, true);
  const other = s.core.keys.generateKeyPair(s.hrp);
  await s.service.bind('devnet', other.address);
  assert.equal((await s.service.view('devnet')).phase, 'changing', 'a newly chosen wallet is pending until the chain applies it');
  s.setClient(fakeNode(record({ rewardWallet: other.address, bannedAtHeight: 70 })));
  const banned = await s.service.view('devnet');
  assert.equal(banned.phase, 'banned');
  assert.ok(banned.notes.some((n) => /banned at block 70/.test(n)));
  s.setClient(fakeNode(record({ deregisteredAtHeight: 80, registered: false })));
  assert.equal((await s.service.view('devnet')).phase, 'left');
});

test('view: block production off is reported honestly and a syncing node is not a pass', async () => {
  const s = await setup(false);
  s.setClient(fakeNode(null, true));
  const v = await s.service.view('devnet');
  assert.equal(v.participating, false);
  assert.equal(v.synced, false);
  assert.equal(v.checks.find((c) => c.label === 'Node running and synchronized')?.pass, false);
  assert.equal(v.checks.find((c) => c.label === 'Block production enabled')?.pass, false);
  assert.ok(v.notes.some((n) => /switched off in Settings/.test(n)));
});

test('view: a node that answers badly yields an unknown view, never a fabricated one', async () => {
  const s = await setup();
  s.setClient({ ...fakeNode(null), health: async () => { throw new Error('boom'); } });
  const v = await s.service.view('devnet');
  assert.equal(v.phase, 'unknown');
  assert.equal(v.checks[0]?.pass, null);
});

test('the RPC parsers accept the 1.9.0 shapes and reject the validator-era ones', () => {
  assert.equal(parseProducers({ tier: 'OPEN', eligible: 0, registered: 0, banned: 0, nodes: [] }).tier, 'OPEN');
  assert.throws(() => parseProducers({ count: 1, registered: [] }));
  const f = parseFinality({ model: 'm', available: false, reason: 'r', finalizedHeight: 0, finalizedHash: '', headHeight: 3, lag: 3, eligibleProducers: 0, window: 32, quorum: 3, minProducers: 3, assumptions: 'a' });
  assert.equal(f.available, false);
  assert.throws(() => parseFinality({ finalizedHeight: 0, finalizedHash: '', headHeight: 0, validatorCount: 4, quorum: 3 }));
  const status = parseNodeStatus({
    nodeId: 'n', rewardWallet: 'w', registered: true, bannedAtHeight: null, deregisteredAtHeight: null, registeredAtHeight: 4, lifetimeRewardObs: '1.5',
    pendingWalletChange: null, pendingReclaim: null, currentPeriod: 2,
    evidence: { heartbeats: 3, liveWindows: 3, expectedWindows: 24, faults: 0 },
  });
  assert.equal(status.liveWindows, 3);
  assert.ok(RpcError);
});
