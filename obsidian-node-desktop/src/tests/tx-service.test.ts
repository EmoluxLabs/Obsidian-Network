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

const PASS = 'correct horse battery staple';
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER = 'dobs1n3u4jh87hqkresdzwyptnj2r8xrf7nnnt9wgwt';

interface Fake {
  submitted: string[];
  simulated: string[];
  simulateResult: { valid: boolean; error: string | null };
  submitBehaviour: 'ok' | 'down' | 'refuse';
  network: string;
  chainId: number;
}

async function setup() {
  const { dir, cleanup } = tempDir();
  const core = await loadCore();
  const wallets = new WalletService(createPaths(dir), () => loadCore());
  const wallet = await wallets.importPhrase('devnet', PHRASE, PASS);
  const fake: Fake = { submitted: [], simulated: [], simulateResult: { valid: true, error: null }, submitBehaviour: 'ok', network: 'devnet', chainId: core.networks.NETWORKS.devnet.chainId };
  const client: any = {
    health: async () => ({ network: fake.network, chainId: fake.chainId, protocolVersion: '1.6.1', syncing: false, height: 5 }),
    pot: async () => ({ protocolTime: 1_800_000_000 }),
    status: async () => ({ lastBlockTimestamp: 1_800_000_000, height: 5 }),
    nextNonce: async () => 0,
    walletBalance: async (a: string) => ({ address: a, balanceObs: '100.000000000000000000', balanceSeals: '100000000000000000000', nonce: 0, txCount: 0, atHeight: 5 }),
    simulate: async (hex: string) => {
      fake.simulated.push(hex);
      return fake.simulateResult;
    },
    submit: async (hex: string) => {
      if (fake.submitBehaviour === 'down') throw new RpcError('unavailable', 'could not reach the node');
      if (fake.submitBehaviour === 'refuse') throw new RpcError('http', 'bad nonce', 400, 'ERR_NONCE');
      const duplicate = fake.submitted.includes(hex);
      if (!duplicate) fake.submitted.push(hex);
      return { accepted: true, duplicate, txId: 'x' };
    },
  };
  const tx = new TxService({ core: () => loadCore(), wallets, rpc: () => client, nodeIdentity: async () => { throw new Error('unused'); }, logs: new LogBuffer(100) });
  const payments = new PaymentService({ core: () => loadCore(), wallets, tx, rpc: () => client });
  return { fake, tx, payments, wallet, cleanup };
}

test('tx: a payment is prepared, signed only after confirmation, simulated, then submitted exactly once', async () => {
  const { fake, tx, payments, cleanup } = await setup();
  try {
    const plan = await payments.prepare('devnet', { to: OTHER, amountObs: '1.5', memo: 'hi' });
    assert.equal(plan.requiresPassphrase, true);
    assert.ok(plan.rows.some((r) => r.label === 'Total debited' && r.value === '1.5003 OBS'), JSON.stringify(plan.rows));
    assert.equal(fake.simulated.length + fake.submitted.length, 0, 'nothing signed or sent before confirmation');
    const result = await tx.execute(plan.prepareId, { passphrase: PASS });
    assert.equal(result.state, 'submitted');
    assert.equal(fake.simulated.length, 1);
    assert.equal(fake.submitted.length, 1);
    assert.equal(fake.simulated[0], fake.submitted[0], 'the node simulated exactly the bytes that were submitted');
    await assert.rejects(tx.execute(plan.prepareId, { passphrase: PASS }), /expired or was already used|already/i, 'a plan can never be used twice');
    assert.equal(fake.submitted.length, 1);
    const [rec] = tx.list('devnet');
    assert.equal(rec!.txId, result.txId);
    assert.equal(rec!.state, 'submitted');
    assert.ok(!JSON.stringify(rec).includes('signedHex'));
  } finally {
    cleanup();
  }
});

test('tx: a wrong passphrase signs nothing and leaves the confirmation usable', async () => {
  const { fake, tx, payments, cleanup } = await setup();
  try {
    const plan = await payments.prepare('devnet', { to: OTHER, amountObs: '2' });
    await assert.rejects(tx.execute(plan.prepareId, { passphrase: 'wrong passphrase!!' }), /passphrase/i);
    await assert.rejects(tx.execute(plan.prepareId, {}), /passphrase/i);
    assert.equal(fake.simulated.length, 0);
    const ok = await tx.execute(plan.prepareId, { passphrase: PASS });
    assert.equal(ok.state, 'submitted');
  } finally {
    cleanup();
  }
});

test('tx: a double click cannot send two transactions', async () => {
  const { fake, tx, payments, cleanup } = await setup();
  try {
    const plan = await payments.prepare('devnet', { to: OTHER, amountObs: '1' });
    const both = await Promise.allSettled([tx.execute(plan.prepareId, { passphrase: PASS }), tx.execute(plan.prepareId, { passphrase: PASS })]);
    assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(both.filter((r) => r.status === 'rejected').length, 1);
    assert.equal(fake.submitted.length, 1);
    // two different confirmations for the same sender cannot overlap either
    const a = await payments.prepare('devnet', { to: OTHER, amountObs: '1' });
    const b = await payments.prepare('devnet', { to: OTHER, amountObs: '1' });
    const two = await Promise.allSettled([tx.execute(a.prepareId, { passphrase: PASS }), tx.execute(b.prepareId, { passphrase: PASS })]);
    assert.ok(two.some((r) => r.status === 'rejected' && /still being sent/.test(String((r as PromiseRejectedResult).reason?.message))), 'second concurrent send is refused');
  } finally {
    cleanup();
  }
});

test('tx: a node rejection is reported as rejected and nothing is submitted', async () => {
  const { fake, tx, payments, cleanup } = await setup();
  try {
    fake.simulateResult = { valid: false, error: 'insufficient balance' };
    const plan = await payments.prepare('devnet', { to: OTHER, amountObs: '1' });
    const r = await tx.execute(plan.prepareId, { passphrase: PASS });
    assert.equal(r.state, 'rejected');
    assert.match(r.error!, /insufficient balance/);
    assert.equal(fake.submitted.length, 0);
    assert.equal(tx.list('devnet')[0]!.state, 'rejected');
  } finally {
    cleanup();
  }
});

test('tx: if the node goes silent during submit the result is "unknown", never success, and resubmitting the same bytes is idempotent', async () => {
  const { fake, tx, payments, cleanup } = await setup();
  try {
    fake.submitBehaviour = 'down';
    const plan = await payments.prepare('devnet', { to: OTHER, amountObs: '1' });
    const r = await tx.execute(plan.prepareId, { passphrase: PASS });
    assert.equal(r.state, 'unknown');
    fake.submitBehaviour = 'ok';
    const again = await tx.resubmit(r.txId);
    assert.equal(again.state, 'submitted');
    assert.equal(again.txId, r.txId, 'same transaction id');
    assert.equal(fake.submitted.length, 1);
    await assert.rejects(tx.resubmit(r.txId), /unknown can be sent again/);
  } finally {
    cleanup();
  }
});

test('tx: refuses to sign for a node that is on another network or chain', async () => {
  const { fake, tx, payments, cleanup } = await setup();
  try {
    const plan = await payments.prepare('devnet', { to: OTHER, amountObs: '1' });
    fake.network = 'mainnet';
    fake.chainId = 7777;
    await assert.rejects(tx.execute(plan.prepareId, { passphrase: PASS }), /reports mainnet/);
    assert.equal(fake.simulated.length, 0);
    assert.equal(fake.submitted.length, 0);
  } finally {
    cleanup();
  }
});

test('payment: rejects bad addresses, amounts, memos and insufficient funds before any dialog', async () => {
  const { payments, cleanup } = await setup();
  try {
    await assert.rejects(payments.prepare('devnet', { to: 'obs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rxdgrkj', amountObs: '1' }), /not a valid devnet address/, 'mainnet address on devnet');
    await assert.rejects(payments.prepare('devnet', { to: 'garbage', amountObs: '1' }), /not a valid/);
    for (const amountObs of ['0', '-1', 'abc', '', '1e3', '0.0000000000000000001']) await assert.rejects(payments.prepare('devnet', { to: OTHER, amountObs }), `amount ${amountObs}`);
    await assert.rejects(payments.prepare('devnet', { to: OTHER, amountObs: '1', memo: 'x'.repeat(5000) }), /note is longer/);
    await assert.rejects(payments.prepare('devnet', { to: OTHER, amountObs: '1000' }), /balance is 100\.00 OBS/);
  } finally {
    cleanup();
  }
});
