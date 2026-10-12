/**
 * Operations on LIVE processes: bootstrap, join, diagnostics and failure injection.
 *
 *   node --test tests/e2e/operations.test.mjs
 *   SKIP_E2E=1 node --test tests/e2e/operations.test.mjs
 *
 * Every command here is the real built CLI, run the way the guides say, against a disposable MAINNET data directory
 * under the system temp dir (never a real one) on shifted ports. Needs only `npm --prefix obsidian-core run build`.
 *
 *   - `init` twice gives the same identity, and the second run writes nothing;
 *   - a conflicting gate list is refused, a missing one is adopted from the manifest;
 *   - `join` refuses a peer serving other keys and writes nothing; with the right pinned id it adopts the network;
 *   - a second `start` on a held data directory fails and the first node survives;
 *   - `status` / `peers` report CONNECTED peers, and after the other node dies they drop to 0 while the saved book
 *     still lists it (saved is never presented as connected);
 *   - `doctor` names a port taken by a stranger;
 *   - usage errors exit 2; `--require-init` will not create a chain.
 */

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createTcp } from 'node:net';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(HERE, '..', '..', 'obsidian-core');
const ENTRY = join(CORE, 'dist', 'index.js');
const NODE_PASS = 'e2e-operations-node-passphrase';
const GATE_PASS = 'e2e-operations-gate-passphrase';

const skip = process.env.SKIP_E2E === '1' ? 'SKIP_E2E=1' : !existsSync(ENTRY) ? 'build obsidian-core first' : false;
const SCALE = (() => {
  const fromEnv = Number(process.env.OBSIDIAN_E2E_TIMEOUT_SCALE);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const cores = cpus()?.length || 1;
  return cores >= 6 ? 1 : cores >= 4 ? 2 : 3;
})();
const ms = (base) => Math.round(base * SCALE);

// Clear of a real deployment (8630/8631), networks.test (9130..) and cluster.test (39630..).
const A = { rpc: 49230, p2p: 49231 };
const B = { rpc: 49232, p2p: 49233 };
const STRANGER = 49236;

const children = [];
const dirs = [];
const servers = [];

function scratch(label) {
  const dir = mkdtempSync(join(tmpdir(), `obsidian-ops-${label}-`));
  dirs.push(dir);
  return dir;
}

function cli(args, env = {}) {
  const result = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: CORE,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, OBSIDIAN_KEYSTORE_PASSPHRASE: NODE_PASS, OBSIDIAN_GATE_KEYSTORE_PASSPHRASE: GATE_PASS, ...env },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function launch(label, args, env = {}, entry = ENTRY) {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: CORE,
    env: { ...process.env, OBSIDIAN_NODE_ONLY: '1', OBSIDIAN_KEYSTORE_PASSPHRASE: NODE_PASS, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const record = { label, child, log: [], code: null };
  child.stdout.on('data', (chunk) => record.log.push(chunk.toString()));
  child.stderr.on('data', (chunk) => record.log.push(chunk.toString()));
  child.on('exit', (code) => {
    record.code = code ?? -1;
  });
  children.push(record);
  return record;
}

const tail = (record) => record.log.join('').split('\n').slice(-8).join('\n');

async function waitFor(condition, timeout, label, record) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    if (record && record.code !== null) throw new Error(`${record.label} exited early (code ${record.code}) while waiting for ${label}\n${tail(record)}`);
    try {
      const value = await condition();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${label}${last ? ` (${last.message})` : ''}${record ? `\n${tail(record)}` : ''}`);
}

const get = async (port, path) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: response.status, body: await response.json() };
};
const peersJson = (port) => JSON.parse(cli(['peers', '--network', 'mainnet', '--url', `http://127.0.0.1:${port}`, '--json']).out);
const stop = async (record) => {
  record.child.kill('SIGTERM');
  await waitFor(() => record.code !== null, ms(15_000), `${record.label} to exit`);
};

after(async () => {
  for (const record of children) if (record.code === null) record.child.kill('SIGTERM');
  for (const server of servers) server.close();
  await new Promise((r) => setTimeout(r, 1500));
  for (const record of children) if (record.code === null) record.child.kill('SIGKILL');
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const ctx = {};

test('init creates the network once, and a second init writes nothing', { skip }, () => {
  ctx.rootA = scratch('a');
  ctx.dirA = join(ctx.rootA, 'data', 'mainnet');
  const base = ['mainnet', 'init', '--data-dir', ctx.dirA, '--generate-gate-key'];
  const first = cli(base);
  assert.equal(first.code, 0, first.err);
  const created = JSON.parse(first.out);
  assert.equal(created.state, 'created');
  assert.equal(created.networkId, 'obsidian-mainnet-1');
  assert.match(created.genesisId, /^[0-9a-f]{40}$/);
  assert.equal(created.miningGatePublicKeys.length, 1);
  ctx.genesisId = created.genesisId;
  ctx.gateKey = created.miningGatePublicKeys[0];
  ctx.gateKeystore = created.gateAuthority.keystore;
  const manifest = readFileSync(join(ctx.dirA, 'network.json'), 'utf8');
  const keystore = readFileSync(created.gateAuthority.keystore, 'utf8');

  const second = cli(base);
  assert.equal(second.code, 0, second.err);
  const again = JSON.parse(second.out);
  assert.equal(again.state, 'existing');
  assert.equal(again.genesisId, created.genesisId);
  assert.equal(readFileSync(join(ctx.dirA, 'network.json'), 'utf8'), manifest);
  assert.equal(readFileSync(created.gateAuthority.keystore, 'utf8'), keystore);
  // Secrets: neither the passphrases nor any private material is in the command output or the manifest.
  for (const text of [first.out, first.err, second.out, manifest]) {
    assert.ok(!text.includes(GATE_PASS) && !text.includes(NODE_PASS));
    assert.ok(!/privateKey|secretKey/i.test(text));
  }
});

test('a conflicting gate list is refused by name; an omitted one is adopted', { skip }, () => {
  const other = JSON.parse(cli(['wallet', 'new', '--network', 'mainnet']).out).publicKey; // a real key that is not the recorded one
  const conflict = cli(['mainnet', 'init', '--data-dir', ctx.dirA], { OBSIDIAN_MINING_GATE_PUBLIC_KEYS: other });
  assert.notEqual(conflict.code, 0);
  assert.match(conflict.err + conflict.out, /differ from the ones this data directory was created with/);
  // Still the same network afterwards.
  const check = JSON.parse(cli(['mainnet', 'init', '--data-dir', ctx.dirA]).out);
  assert.equal(check.genesisId, ctx.genesisId);
  assert.deepEqual(check.miningGatePublicKeys, [ctx.gateKey]);
});

test('--require-init will not create a chain in an empty directory', { skip }, () => {
  const empty = scratch('empty');
  const result = cli(['mainnet', 'start', '--require-init', '--data-dir', join(empty, 'x'), '--rpc-port', '49240', '--p2p-port', '49241']);
  assert.notEqual(result.code, 0);
  assert.match(result.err, /no network yet/);
  assert.ok(!existsSync(join(empty, 'x', 'chain')), 'no chain was created');
  assert.ok(!existsSync(join(empty, 'x', 'network.json')), 'no manifest was created');
});

test('usage mistakes exit 2, not 1', { skip }, () => {
  assert.equal(cli(['mainnet']).code, 2);
  assert.equal(cli(['sync', 'bogus', '--network', 'mainnet']).code, 2);
  assert.equal(cli(['join', '--network', 'mainnet', '--data-dir', scratch('j')]).code, 2);
});

test('node A starts from the initialised directory with the recorded identity', { skip }, async () => {
  ctx.a = launch('node-a', ['mainnet', 'start', '--require-init', '--no-mine', '--data-dir', ctx.dirA, '--rpc-port', String(A.rpc), '--p2p-port', String(A.p2p), '--log-level', 'warn']);
  await waitFor(async () => (await get(A.rpc, '/readyz')).body.status, ms(30_000), 'node A readiness answer', ctx.a);
  const health = (await get(A.rpc, '/health')).body;
  assert.equal(health.genesisId, ctx.genesisId, 'the running chain is the one init recorded');
  const gate = (await get(A.rpc, '/genesis')).body.document.miningGatePublicKeys;
  assert.deepEqual(gate, [ctx.gateKey]);
  assert.equal((await get(A.rpc, '/livez')).status, 200);
});

test('the gate authority flow works against a live node: status, propose, sign, dry-run, submit (protocol 1.8.0)', { skip }, async () => {
  const url = ['--network', 'mainnet', '--url', `http://127.0.0.1:${A.rpc}`];
  const status = cli(['gate', 'status', ...url, '--json']);
  assert.equal(status.code, 0, status.err);
  const live = JSON.parse(status.out);
  assert.deepEqual(live.issuerKeys, [ctx.gateKey]);
  assert.equal(live.epoch, 0);

  const { generateKeyPair } = await import(join(CORE, 'dist', 'crypto', 'keys.js'));
  const fresh = generateKeyPair('obs').publicKey;
  const file = join(ctx.rootA, 'gate-proposal.json');
  const proposed = cli(['gate', 'propose', ...url, '--add', fresh, '--out', file]);
  assert.equal(proposed.code, 0, proposed.err);

  const wrong = cli(['gate', 'sign', '--network', 'mainnet', '--proposal', file, '--keystore', ctx.gateKeystore], { OBSIDIAN_GATE_KEYSTORE_PASSPHRASE: 'not-the-passphrase-at-all' });
  assert.notEqual(wrong.code, 0, 'a wrong passphrase must not sign');
  const unsigned = cli(['gate', 'submit', ...url, '--proposal', file, '--dry-run']);
  assert.notEqual(unsigned.code, 0, 'a proposal without a quorum must be refused before it is sent');

  const signed = cli(['gate', 'sign', '--network', 'mainnet', '--proposal', file, '--keystore', ctx.gateKeystore]);
  assert.equal(signed.code, 0, signed.err);
  for (const text of [signed.out, signed.err, readFileSync(file, 'utf8')]) {
    assert.ok(!text.includes(GATE_PASS), 'the passphrase never appears');
    assert.ok(!/privateKey|secretKey/i.test(text), 'no private material appears');
  }
  const dry = cli(['gate', 'submit', ...url, '--proposal', file, '--dry-run']);
  assert.equal(dry.code, 0, dry.err);
  assert.equal(JSON.parse(dry.out).accepted, false);

  const sent = cli(['gate', 'submit', ...url, '--proposal', file]);
  assert.equal(sent.code, 0, sent.err);
  assert.equal(JSON.parse(sent.out).accepted, true, 'the live node admitted the update');
  // This node is not producing blocks (--no-mine), so the set cannot change here: the update waits in the mempool.
  const after = (await get(A.rpc, '/gate')).body;
  assert.deepEqual(after.issuerKeys, [ctx.gateKey]);
  assert.equal(after.epoch, 0);
});

test('status, peers and sync report an isolated node honestly (degraded, zero live peers)', { skip }, () => {
  const url = ['--network', 'mainnet', '--url', `http://127.0.0.1:${A.rpc}`];
  const status = cli(['status', ...url]);
  assert.equal(status.code, 3, status.out);
  assert.match(status.out, /readiness:\s+ready-degraded \(no-peers\)/);
  assert.match(status.out, /0 connected/);
  assert.match(status.out, new RegExp(ctx.genesisId));
  const alias = cli(['node', 'status', ...url]);
  assert.equal(alias.out, status.out, '`node status` is the same command, not a lookalike');
  assert.match(cli(['node', 'peers', ...url]).out, /0 connected peer/);
  assert.match(cli(['node', 'sync', 'status', ...url]).out, /ALONE/);
});

test('a second start on the same data directory fails, and node A is unharmed', { skip }, async () => {
  const second = launch('node-a-dup', ['mainnet', 'start', '--no-mine', '--data-dir', ctx.dirA, '--rpc-port', '49250', '--p2p-port', '49251', '--log-level', 'warn']);
  await waitFor(() => second.code !== null, ms(20_000), 'the duplicate start to exit');
  assert.notEqual(second.code, 0);
  assert.match(second.log.join(''), /lock|in use|already/i);
  assert.equal((await get(A.rpc, '/livez')).status, 200);
  assert.equal((await get(A.rpc, '/health')).body.genesisId, ctx.genesisId);
});

test('join refuses a peer that serves a different key set, and writes nothing', { skip }, async () => {
  // The liar answers /genesis with a perfectly well-formed document that has ITS gate key.
  const genuine = (await get(A.rpc, '/genesis')).body;
  const forged = JSON.parse(JSON.stringify(genuine));
  forged.document.miningGatePublicKeys = ['03' + 'cd'.repeat(32)];
  // A separate process: the CLI calls below block this one (spawnSync), so an in-process server could never answer.
  const liar = launch(
    'liar',
    ["require('node:http').createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(q.url==='/genesis'?process.env.FORGED:'{}')}).listen(49237,'127.0.0.1')"],
    { FORGED: JSON.stringify(forged) },
    '-e',
  );
  await waitFor(async () => (await fetch('http://127.0.0.1:49237/genesis')).status === 200, ms(10_000), 'the liar to listen');
  ctx.rootB = scratch('b');
  ctx.dirB = join(ctx.rootB, 'data', 'mainnet');
  const result = cli(['mainnet', 'join', '--data-dir', ctx.dirB, '--peer', 'http://127.0.0.1:49237', '--genesis-id', ctx.genesisId]);
  assert.equal(result.code, 1);
  assert.match(result.err, /Nothing was written|unusable keys|pinned/);
  assert.ok(!existsSync(join(ctx.dirB, 'network.json')));
  // A peer that cannot be reached is an error too, not a hang.
  const dead = cli(['mainnet', 'join', '--data-dir', ctx.dirB, '--peer', 'http://127.0.0.1:49239', '--genesis-id', ctx.genesisId]);
  assert.equal(dead.code, 1);
  assert.ok(!existsSync(join(ctx.dirB, 'network.json')));
});

test('join with the pinned id adopts the network; B then peers with A and follows it', { skip }, async () => {
  const wrongPin = cli(['mainnet', 'join', '--data-dir', ctx.dirB, '--peer', `http://127.0.0.1:${A.rpc}`, '--genesis-id', '0'.repeat(40)]);
  assert.equal(wrongPin.code, 1);
  assert.ok(!existsSync(join(ctx.dirB, 'network.json')));

  const joined = cli(['mainnet', 'join', '--data-dir', ctx.dirB, '--peer', `http://127.0.0.1:${A.rpc}`, '--genesis-id', ctx.genesisId]);
  assert.equal(joined.code, 0, joined.err);
  assert.equal(JSON.parse(joined.out).genesisId, ctx.genesisId);
  assert.ok(!/privateKey/i.test(joined.out));

  ctx.b = launch('node-b', ['mainnet', 'start', '--require-init', '--no-mine', '--data-dir', ctx.dirB, '--rpc-port', String(B.rpc), '--p2p-port', String(B.p2p), '--seeds', `127.0.0.1:${A.p2p}`, '--log-level', 'warn']);
  await waitFor(async () => (await get(B.rpc, '/health')).body.genesisId === ctx.genesisId, ms(30_000), 'node B up on the joined network', ctx.b);
  await waitFor(() => peersJson(B.rpc).peers?.connected === 1, ms(30_000), 'B to hold a live peer', ctx.b);
  await waitFor(() => peersJson(A.rpc).peers?.connected === 1, ms(30_000), 'A to see B');
  const seen = peersJson(B.rpc);
  assert.equal(seen.peers.connectedList.length, 1);
  assert.equal(seen.peers.pendingHandshakes, 0);
  const humanStatus = cli(['status', '--network', 'mainnet', '--url', `http://127.0.0.1:${B.rpc}`]);
  assert.equal(humanStatus.code, 0, humanStatus.out);
  assert.match(humanStatus.out, /1 connected/);
});

test('when A dies, B shows ZERO connected peers while the saved book still lists A', { skip }, async () => {
  await stop(ctx.a);
  await waitFor(() => peersJson(B.rpc).peers?.connected === 0, ms(30_000), 'B to notice the loss', ctx.b);
  const after = peersJson(B.rpc);
  assert.equal(after.peers.connectedList.length, 0);
  assert.ok(after.peers.known >= 1, 'the saved book remembers A');
  const text = cli(['peers', '--network', 'mainnet', '--url', `http://127.0.0.1:${B.rpc}`]).out;
  assert.match(text, /0 connected peer/);
  assert.match(text, /NOT connected unless listed/);
  const status = cli(['status', '--network', 'mainnet', '--url', `http://127.0.0.1:${B.rpc}`]);
  assert.equal(status.code, 3);
  assert.match(status.out, /no live peer/);
  // A is gone for good: its data directory is intact and it restarts to the same identity.
  assert.ok(existsSync(join(ctx.dirA, 'network.json')));
});

test('status on a port where nothing listens is UNREACHABLE and exits 1', { skip }, () => {
  const result = cli(['status', '--network', 'mainnet', '--url', 'http://127.0.0.1:49245']);
  assert.equal(result.code, 1);
  assert.match(result.out, /UNREACHABLE/);
});

test('doctor names a port held by a stranger, and a node refuses to start on it', { skip }, async () => {
  const stranger = createTcp();
  await new Promise((r) => stranger.listen(STRANGER, '127.0.0.1', r));
  servers.push(stranger);
  const dir = join(scratch('doc'), 'm');
  const doctor = cli(['mainnet', 'doctor', '--data-dir', dir, '--rpc-port', String(STRANGER), '--p2p-port', '49247']);
  assert.equal(doctor.code, 1, doctor.out);
  assert.match(doctor.out, /\[FAIL\] rpc port: 127\.0\.0\.1:49236 is already in use/);
  const refused = launch('node-conflict', ['mainnet', 'start', '--no-mine', '--data-dir', dir, '--rpc-port', String(STRANGER), '--p2p-port', '49247', '--log-level', 'warn']);
  await waitFor(() => refused.code !== null, ms(20_000), 'the conflicting start to exit', undefined);
  assert.notEqual(refused.code, 0);
  assert.match(refused.log.join(''), /EADDRINUSE|in use/i);
});

test('doctor reports a corrupt manifest instead of guessing', { skip }, () => {
  const dir = join(scratch('corrupt'), 'm');
  assert.equal(cli(['mainnet', 'init', '--data-dir', dir]).code, 0);
  writeFileSync(join(dir, 'network.json'), '{ broken');
  const doctor = cli(['mainnet', 'doctor', '--data-dir', dir, '--rpc-port', '49248', '--p2p-port', '49249']);
  assert.equal(doctor.code, 1);
  assert.match(doctor.out, /\[FAIL\] network manifest: .*not valid JSON/);
  const start = cli(['mainnet', 'start', '--no-mine', '--data-dir', dir, '--rpc-port', '49248', '--p2p-port', '49249']);
  assert.notEqual(start.code, 0);
  assert.match(start.err, /not valid JSON/);
  assert.equal(readFileSync(join(dir, 'network.json'), 'utf8'), '{ broken');
  assert.ok(!readdirSync(dir).includes('chain'));
});
