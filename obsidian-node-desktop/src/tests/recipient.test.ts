import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadCore } from '../core/core-loader.js';
import { createPaths } from '../core/paths.js';
import { LogBuffer } from '../core/log-buffer.js';
import { PaymentService } from '../core/payment-service.js';
import { RpcError } from '../core/rpc-client.js';
import { TxService } from '../core/tx-service.js';
import { WalletService } from '../core/wallet-service.js';
import { tempDir } from './helpers.js';

/**
 * Paying a `.obs` name from the desktop app. The node is a stub: nothing here touches a real network or any OBS.
 * What is pinned: the name is resolved from the node's ONS record held against the chosen network; the plan shows the name,
 * the whole address and the status; the transaction carries the address and never the name; every failure stops with its
 * own message and signs nothing; and a name that changes after the plan was shown is not signed.
 */

const PASS = 'correct horse battery staple';
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const NOW = 1_800_000_000;

async function setup() {
  const { dir, cleanup } = tempDir();
  const core = await loadCore();
  const wallets = new WalletService(createPaths(dir), () => loadCore());
  await wallets.importPhrase('devnet', PHRASE, PASS);
  const devnet = core.networks.NETWORKS.devnet;
  const other = core.keys.generateKeyPair('dobs').address;
  const registered = core.keys.generateKeyPair('dobs').address;
  const owner = core.keys.generateKeyPair('dobs').address;
  const world = {
    submitted: [] as string[],
    lookups: [] as string[],
    network: 'devnet',
    chainId: devnet.chainId,
    names: {
      'obsidian.obs': { name: 'obsidian.obs', owner, address: registered, registeredAt: NOW - 9, registeredAtHeight: 2, expiresAt: NOW + 5000, transferCount: 0, resolved: true } as Record<string, unknown>,
    } as Record<string, Record<string, unknown>>,
    lookup: null as null | ((name: string) => unknown),
  };
  const client: any = {
    health: async () => ({ network: world.network, chainId: world.chainId, protocolVersion: '1.8.2', syncing: false, height: 5 }),
    pot: async () => ({ protocolTime: NOW }),
    status: async () => ({ lastBlockTimestamp: NOW, height: 5 }),
    nextNonce: async () => 0,
    walletBalance: async (a: string) => ({ address: a, balanceObs: '100.000000000000000000', balanceSeals: '100000000000000000000', nonce: 0, txCount: 0, atHeight: 5 }),
    nameRecord: async (name: string) => {
      world.lookups.push(name);
      if (world.lookup) return world.lookup(name);
      const record = world.names[name];
      if (!record) throw new RpcError('http', 'name not registered', 404, 'ERR_NOT_FOUND');
      return record;
    },
    simulate: async () => ({ valid: true, error: null }),
    submit: async (hex: string) => {
      world.submitted.push(hex);
      return { accepted: true, duplicate: false, txId: 'x' };
    },
  };
  const tx = new TxService({ core: () => loadCore(), wallets, rpc: () => client, nodeIdentity: async () => { throw new Error('unused'); }, logs: new LogBuffer(100) });
  const payments = new PaymentService({ core: () => loadCore(), wallets, tx, rpc: () => client });
  return { core, world, tx, payments, other, registered, owner, cleanup };
}

const paidTo = async (core: Awaited<ReturnType<typeof loadCore>>, hex: string) => {
  const signed = core.encode.decodeSignedTxFromBytes(Uint8Array.from(Buffer.from(hex, 'hex')));
  return core.payment.decodePaymentBody(signed.body);
};

test('ons: a native address is prepared as before, with no name lookup', async () => {
  const { world, payments, other, cleanup } = await setup();
  try {
    const plan = await payments.prepare('devnet', { to: other, amountObs: '1' });
    assert.ok(plan.rows.some((r) => r.label === 'To' && r.value === other));
    assert.ok(!plan.rows.some((r) => r.label === 'ONS name'));
    assert.deepEqual(world.lookups, []);
  } finally {
    cleanup();
  }
});

test('ons: a registered name is resolved, shown in full, and the signed payment carries the address — never the name', async () => {
  const { core, world, tx, payments, registered, cleanup } = await setup();
  try {
    const plan = await payments.prepare('devnet', { to: '  Obsidian.OBS ', amountObs: '1.5' });
    assert.deepEqual(world.lookups, ['obsidian.obs']);
    const row = (label: string) => plan.rows.find((r) => r.label === label)?.value;
    assert.equal(row('ONS name'), 'obsidian.obs');
    assert.equal(row('Resolves to'), registered, 'the whole address, unshortened');
    assert.equal(row('ONS status'), 'Registered on-chain');
    assert.equal(row('Network'), 'devnet');
    assert.ok(!plan.rows.some((r) => r.label === 'To'));
    assert.equal(world.submitted.length, 0, 'preparing a plan never signs or sends');

    const result = await tx.execute(plan.prepareId, { passphrase: PASS });
    assert.equal(result.state, 'submitted');
    assert.equal(world.submitted.length, 1);
    assert.equal(world.lookups.length, 2, 'asked again immediately before signing');
    const body = await paidTo(core, world.submitted[0]!);
    assert.equal(body.to, registered);
    assert.ok(!world.submitted[0]!.includes(Buffer.from('obsidian.obs').toString('hex')), 'the name is not in the signed bytes');
  } finally {
    cleanup();
  }
});

test('ons: a name repointed, lapsed or unreadable after the plan was shown is not signed', async () => {
  for (const change of [
    (w: any, c: any) => { w.names['obsidian.obs'].address = c.keys.generateKeyPair('dobs').address; },
    (w: any) => { w.names['obsidian.obs'].expiresAt = NOW; },
    (w: any) => { delete w.names['obsidian.obs']; },
    (w: any) => { w.lookup = () => { throw new RpcError('unavailable', 'could not reach the node'); }; },
  ]) {
    const { core, world, tx, payments, cleanup } = await setup();
    try {
      const plan = await payments.prepare('devnet', { to: 'obsidian.obs', amountObs: '1' });
      change(world, core);
      await assert.rejects(tx.execute(plan.prepareId, { passphrase: PASS }), /Nothing was signed|different address/);
      assert.equal(world.submitted.length, 0);
      await assert.rejects(tx.execute(plan.prepareId, { passphrase: PASS }), /expired or was already used/, 'the plan is dropped');
    } finally {
      cleanup();
    }
  }
});

test('ons: each failed lookup stops the plan with its own message', async () => {
  const cases: Array<[string, string, (w: any, c: any) => void, string, string]> = [
    ['unregistered', 'nobody.obs', () => undefined, 'ONS_NAME_NOT_FOUND', 'ONS name not found on Devnet.'],
    ['node error', 'obsidian.obs', (w) => { w.lookup = () => { throw new RpcError('http', 'boom', 500); }; }, 'ONS_LOOKUP_UNAVAILABLE', 'Could not resolve this ONS name. Please try again.'],
    ['node unreachable', 'obsidian.obs', (w) => { w.lookup = () => { throw new RpcError('unavailable', 'could not reach the node'); }; }, 'ONS_LOOKUP_UNAVAILABLE', 'Could not resolve this ONS name. Please try again.'],
    ['not a record', 'obsidian.obs', (w) => { w.lookup = () => ({ hello: 1 }); }, 'ONS_MALFORMED_RECORD', 'The ONS lookup returned an unusable answer. Transaction blocked.'],
    ['invalid address', 'obsidian.obs', (w) => { w.names['obsidian.obs'].address = 'dobs1notanaddress'; }, 'ONS_INVALID_ADDRESS', 'ONS name resolved to an invalid OBS address. Transaction blocked.'],
    ['mainnet address', 'obsidian.obs', (w, c) => { w.names['obsidian.obs'].address = c.keys.generateKeyPair('obs').address; }, 'ONS_NETWORK_MISMATCH', 'ONS lookup came from a different network than Obsidian Devnet. Transaction blocked.'],
    ['node on another network', 'obsidian.obs', (w) => { w.network = 'testnet'; w.chainId = 7778; }, 'ONS_NETWORK_MISMATCH', 'ONS lookup came from a different network than Obsidian Devnet. Transaction blocked.'],
    ['expired', 'obsidian.obs', (w) => { w.names['obsidian.obs'].expiresAt = NOW - 1; }, 'ONS_NAME_EXPIRED', 'This ONS name has expired, so its address is no longer trusted. Transaction blocked.'],
    ['malformed name', 'foo bar.obs', () => undefined, 'ONS_NAME_INVALID', 'That is not a valid ONS name. Use 3–63 letters, numbers or interior hyphens, then .obs.'],
  ];
  for (const [label, typed, arrange, code, message] of cases) {
    const { core, world, payments, cleanup } = await setup();
    try {
      arrange(world, core);
      await assert.rejects(payments.prepare('devnet', { to: typed, amountObs: '1' }), (error: any) => {
        assert.equal(error.code, code, label);
        assert.equal(error.message, message, label);
        return true;
      });
      assert.equal(world.submitted.length, 0, label);
      if (label === 'malformed name') assert.deepEqual(world.lookups, [], 'the node is never asked about a malformed name');
    } finally {
      cleanup();
    }
  }
});

test('ons: a failed lookup is not an invalid-address error, and an invalid address is not a lookup error', async () => {
  const { world, payments, cleanup } = await setup();
  try {
    world.lookup = () => { throw new RpcError('http', 'bad gateway', 502); };
    await assert.rejects(payments.prepare('devnet', { to: 'obsidian.obs', amountObs: '1' }), (e: any) => e.code === 'ONS_LOOKUP_UNAVAILABLE' && !/invalid/i.test(e.message));
    await assert.rejects(payments.prepare('devnet', { to: 'dobs1notanaddress', amountObs: '1' }), (e: any) => e.code === 'INVALID_ADDRESS');
  } finally {
    cleanup();
  }
});
