/**
 * Four networks, four interfaces, one machine — and they must never mix.
 *
 *   node --test tests/e2e/networks.test.mjs
 *   SKIP_E2E=1 node --test tests/e2e/networks.test.mjs     # skip on a slow machine
 *
 * The launch guides tell an operator to run devnet, testnet, staging and mainnet
 * as four separate sets of commands. This test runs exactly those commands (the
 * built node and the built interface, started the way the guides say, only on
 * shifted ports so it can run next to a real deployment) and then tries, on
 * purpose, to get the networks to touch each other:
 *
 *   - every node reports its OWN network id, chain id and genesis id, and the
 *     genesis ids are the ones `genesis init` derives;
 *   - an address minted for one network is refused by the other three;
 *   - an interface serves only the network it was started for, and one that is
 *     pointed at a node of another network refuses to show it;
 *   - nodes of different networks never peer, even when told each other's port;
 *   - two nodes of the SAME network do peer and follow each other;
 *   - the devnet Genesis Invitation opens the devnet interface exactly once, and
 *     the other interfaces, which were given none, refuse to create an account.
 *
 * Needs both packages built:
 *   npm --prefix obsidian-core run build && npm --prefix obsidian-interface run build
 */

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import { PROTOCOL_VERSION } from '../../obsidian-core/dist/version.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CORE = join(ROOT, 'obsidian-core');
const INTERFACE = join(ROOT, 'obsidian-interface');
const NODE_ENTRY = join(CORE, 'dist', 'index.js');
const INTERFACE_ENTRY = join(INTERFACE, 'dist', 'server', 'main.js');
const INVITE_SCRIPT = join(ROOT, 'scripts', 'new-genesis-invite.mjs');
const PASSPHRASE = 'e2e-networks-passphrase';

/** Ports are the defaults plus 500, clear of a real deployment AND of the cluster test (39630-39635). */
const NETWORKS = [
  { name: 'mainnet', chainId: 7777, hrp: 'obs', rpc: 9130, p2p: 9131, ui: 9288 },
  { name: 'testnet', chainId: 7778, hrp: 'tobs', rpc: 19130, p2p: 19131, ui: 19288 },
  { name: 'staging', chainId: 7779, hrp: 'sobs', rpc: 29130, p2p: 29131, ui: 29288 },
  { name: 'devnet', chainId: 7780, hrp: 'dobs', rpc: 39130, p2p: 39131, ui: 39288 },
];
const byName = Object.fromEntries(NETWORKS.map((network) => [network.name, network]));
const SITES = ['/', '/mine/', '/wallet/', '/explorer/', '/ons/', '/node/', '/developer/', '/app/', '/audit/'];

const skip = process.env.SKIP_E2E === '1'
  ? 'SKIP_E2E=1'
  : !existsSync(NODE_ENTRY) || !existsSync(INTERFACE_ENTRY)
    ? 'build obsidian-core and obsidian-interface first'
    : false;

const SCALE = (() => {
  const fromEnv = Number(process.env.OBSIDIAN_E2E_TIMEOUT_SCALE);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const cores = cpus()?.length || 1;
  return cores >= 6 ? 1 : cores >= 4 ? 2 : 3;
})();
const ms = (base) => Math.round(base * SCALE);

const children = [];
const dirs = [];
let invite; // { code, hash } for the devnet interface

// ── processes ────────────────────────────────────────────────────────────────

function scratch(label) {
  const dir = mkdtempSync(join(tmpdir(), `obsidian-nets-${label}-`));
  dirs.push(dir);
  return dir;
}

function launch(label, entry, args, env = {}, cwd = ROOT) {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd,
    env: { ...process.env, OBSIDIAN_KEYSTORE_PASSPHRASE: PASSPHRASE, ...env },
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

function startNode(label, network, extra = []) {
  const dir = scratch(label);
  return launch(
    label,
    NODE_ENTRY,
    ['start', '--network', network.name, '--data-dir', dir, '--rpc-port', String(network.rpc), '--p2p-port', String(network.p2p), '--log-level', 'warn', ...extra],
    {},
    CORE,
  );
}

function startInterface(label, networkName, port, nodeUrl, env = {}) {
  return launch(
    label,
    INTERFACE_ENTRY,
    ['--network', networkName, '--port', String(port), '--nodes', nodeUrl, '--data-dir', scratch(`${label}-data`)],
    env,
    INTERFACE,
  );
}

function logTail(record) {
  return record.log.join('').split('\n').slice(-10).join('\n');
}

async function waitFor(condition, timeout, label, record) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    if (record && record.code !== null) throw new Error(`${record.label} exited early (code ${record.code}) while waiting for ${label}\n${logTail(record)}`);
    try {
      const value = await condition();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${label}${last ? ` (${last.message})` : ''}${record ? `\n${logTail(record)}` : ''}`);
}

const json = async (url, init) => {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
};
const nodeUrl = (network) => `http://127.0.0.1:${network.rpc}`;
const uiUrl = (network) => `http://127.0.0.1:${network.ui}`;
const status = async (network) => (await json(`${nodeUrl(network)}/status`)).body;

before(async () => {
  if (skip) return;
  // Mint the devnet invitation first: the devnet interface is started WITH its hash.
  const minted = spawnSync(process.execPath, [INVITE_SCRIPT, '--json'], { encoding: 'utf8' });
  assert.equal(minted.status, 0, minted.stderr);
  invite = JSON.parse(minted.stdout);

  for (const network of NETWORKS) startNode(`${network.name}-node`, network);
  for (const network of NETWORKS) {
    startInterface(
      `${network.name}-interface`,
      network.name,
      network.ui,
      nodeUrl(network),
      network.name === 'devnet' ? { OBSIDIAN_GENESIS_INVITE_HASH: invite.hash } : {},
    );
  }
  for (const network of NETWORKS) {
    const node = children.find((record) => record.label === `${network.name}-node`);
    await waitFor(async () => (await status(network)).height >= 1, ms(40_000), `${network.name} node to produce a block`, node);
  }
  for (const network of NETWORKS) {
    const ui = children.find((record) => record.label === `${network.name}-interface`);
    await waitFor(async () => (await json(`${uiUrl(network)}/api/health`)).body.healthyNodes === 1, ms(30_000), `${network.name} interface to see its node`, ui);
  }
});

after(async () => {
  for (const record of children) {
    if (record.code === null) record.child.kill('SIGTERM');
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  for (const record of children) {
    if (record.code === null) record.child.kill('SIGKILL');
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// ── the tests ────────────────────────────────────────────────────────────────

test('every node reports its own network, chain and genesis, and they are all different', { skip }, async () => {
  const genesisIds = new Set();
  const paramsHashes = new Set();
  for (const network of NETWORKS) {
    const s = await status(network);
    const derived = JSON.parse(
      spawnSync(process.execPath, [NODE_ENTRY, 'genesis', 'init', '--network', network.name], { encoding: 'utf8', cwd: CORE }).stdout,
    );
    assert.equal(s.networkId, `obsidian-${network.name}-1`);
    assert.equal(s.chainId, network.chainId);
    assert.equal(s.protocolVersion, PROTOCOL_VERSION);
    assert.equal(s.genesisId, derived.genesisId, `${network.name}: the running genesis must be the one \`genesis init\` derives`);
    const described = (await json(`${nodeUrl(network)}/network`)).body.network;
    assert.equal(described.addressHrp, network.hrp);
    assert.equal(described.chainId, network.chainId);
    genesisIds.add(s.genesisId);
    paramsHashes.add(s.paramsHash);
  }
  assert.equal(genesisIds.size, 4, 'four networks, four genesis ids');
  assert.equal(paramsHashes.size, 1, 'the consensus parameter set is one and the same');
});

test('each network advertises its own official hostnames and no other network\'s', { skip }, async () => {
  // Those names are how people check a wallet address; a practice chain must not vouch for mainnet's.
  const own = {
    mainnet: ['obsmainnet.us.ci', 'api.obsmainnet.us.ci'],
    testnet: ['testnet.obsmainnet.us.ci'],
    staging: ['staging.obsmainnet.us.ci'],
    devnet: ['devnet.obsmainnet.us.ci'],
  };
  for (const network of NETWORKS) {
    const body = (await json(`${nodeUrl(network)}/network`)).body;
    for (const host of own[network.name]) assert.ok(body.domains.includes(host), `${network.name} names ${host}`);
    for (const [other, hosts] of Object.entries(own)) {
      if (other === network.name) continue;
      for (const host of hosts) assert.ok(!body.domains.includes(host), `${network.name} must not advertise ${other}'s ${host}`);
    }
    assert.equal(body.trust.officialDomains, true, `${network.name} trusts the official domain by default`);
  }
});

test('an address minted for one network is refused by the other three', { skip }, async () => {
  for (const owner of NETWORKS) {
    const wallet = JSON.parse(spawnSync(process.execPath, [NODE_ENTRY, 'wallet', 'new', '--network', owner.name], { encoding: 'utf8', cwd: CORE }).stdout);
    assert.ok(wallet.address.startsWith(`${owner.hrp}1`), `${owner.name} wallet is ${wallet.address}`);
    for (const target of NETWORKS) {
      const answer = await json(`${nodeUrl(target)}/wallet/${wallet.address}/next-nonce`);
      if (target.name === owner.name) {
        assert.equal(answer.status, 200, `${owner.name}'s own node must accept its address`);
      } else {
        assert.equal(answer.status, 400, `${target.name} must refuse a ${owner.name} address`);
        assert.equal(answer.body.code, 'ERR_BAD_ADDRESS');
      }
    }
  }
});

test('each interface serves exactly the network it was started for, and all nine sites', { skip }, async () => {
  for (const network of NETWORKS) {
    const health = (await json(`${uiUrl(network)}/api/health`)).body;
    assert.equal(health.network, network.name);
    assert.equal(health.healthyNodes, 1);
    const viaInterface = (await json(`${uiUrl(network)}/api/rpc?path=/status`)).body;
    assert.equal(viaInterface.networkId, `obsidian-${network.name}-1`, `${network.name} interface must read ${network.name}`);
    for (const site of SITES) {
      const response = await fetch(`${uiUrl(network)}${site}`);
      assert.equal(response.status, 200, `${network.name} interface ${site}`);
      await response.arrayBuffer();
    }
    const csp = (await fetch(uiUrl(network))).headers.get('content-security-policy');
    assert.match(csp ?? '', /default-src 'self'/);
  }
});

test('an interface pointed at another network\'s node refuses to show it', { skip }, async () => {
  const wrong = startInterface('miswired-interface', 'devnet', 39289, nodeUrl(byName.mainnet));
  await waitFor(async () => (await json('http://127.0.0.1:39289/api/health')).status === 200, ms(20_000), 'the miswired interface to start', wrong);
  await waitFor(async () => (await json('http://127.0.0.1:39289/api/nodes')).body.nodes?.[0]?.lastCheckedAt > 0, ms(15_000), 'its first health check', wrong);
  const health = (await json('http://127.0.0.1:39289/api/health')).body;
  assert.equal(health.network, 'devnet');
  assert.equal(health.healthyNodes, 0, 'the mainnet node is healthy, and still must not count');
  const nodes = (await json('http://127.0.0.1:39289/api/nodes')).body.nodes;
  assert.match(nodes[0].lastError, /wrong network: this node follows obsidian-mainnet-1.*this interface serves obsidian-devnet-1/);
  const read = await json('http://127.0.0.1:39289/api/rpc?path=/status');
  assert.equal(read.status, 503);
  assert.equal(read.body.code, 'ERR_WRONG_NETWORK');
});

test('nodes of different networks never peer, even when told each other\'s port', { skip }, async () => {
  const stranger = startNode('stranger-node', { name: 'devnet', rpc: 39150, p2p: 39151 }, ['--seeds', `127.0.0.1:${byName.mainnet.p2p},127.0.0.1:${byName.testnet.p2p},127.0.0.1:${byName.staging.p2p}`]);
  await waitFor(async () => (await json('http://127.0.0.1:39150/status')).body.height >= 1, ms(30_000), 'the stranger node to start', stranger);
  // Give it several dial attempts (it retries on a timer) and then look.
  await new Promise((resolve) => setTimeout(resolve, ms(12_000)));
  assert.equal((await json('http://127.0.0.1:39150/status')).body.peers, 0, 'the devnet stranger must have no peers');
  for (const other of ['mainnet', 'testnet', 'staging']) {
    assert.equal((await status(byName[other])).peers, 0, `${other} must not have been joined by a devnet node`);
  }
});

test('two nodes of the same network do peer, and follow one chain', { skip }, async () => {
  const second = startNode('devnet-second', { name: 'devnet', rpc: 39160, p2p: 39161 }, ['--seeds', `127.0.0.1:${byName.devnet.p2p}`]);
  await waitFor(async () => (await json('http://127.0.0.1:39160/status')).body.peers >= 1, ms(30_000), 'the second devnet node to find the first', second);
  await waitFor(
    async () => {
      const [a, b] = [await status(byName.devnet), (await json('http://127.0.0.1:39160/status')).body];
      return Math.abs(a.height - b.height) <= 2 && b.height >= 3;
    },
    ms(30_000),
    'both devnet nodes to agree on the height',
    second,
  );
  const a = await status(byName.devnet);
  const b = (await json('http://127.0.0.1:39160/status')).body;
  assert.equal(a.genesisId, b.genesisId);
  assert.ok(a.peers >= 1);
});

test('the devnet invitation opens the devnet interface exactly once; the others have none', { skip }, async () => {
  const devnet = uiUrl(byName.devnet);
  const register = (base, body) =>
    json(`${base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const account = { email: 'founder-tester@gmail.com', password: 'a-long-passphrase-9' };

  assert.deepEqual((await json(`${devnet}/api/auth/config`)).body.genesisInvite, { configured: true, redeemed: false });
  const wrong = await register(devnet, { ...account, inviteCode: 'OBS-GENESIS-AAAA-BBBB-CCCC-DDDD' });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.code, 'ERR_GENESIS_INVITE_INVALID_OR_USED');

  const opened = await register(devnet, { ...account, inviteCode: invite.code });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.bootstrapped, true);
  assert.equal(opened.body.recoveryCodes.length, 10);

  const again = await register(devnet, { email: 'second-tester@gmail.com', password: 'a-long-passphrase-9', inviteCode: invite.code });
  assert.equal(again.status, 403, 'the invitation is single use');
  assert.deepEqual((await json(`${devnet}/api/auth/config`)).body.genesisInvite, { configured: true, redeemed: true });

  // The devnet code must mean nothing to any other network's interface.
  for (const name of ['mainnet', 'testnet', 'staging']) {
    const refused = await register(uiUrl(byName[name]), { ...account, inviteCode: invite.code });
    assert.equal(refused.status, 503, `${name} has no Genesis Invitation configured`);
    assert.equal(refused.body.code, 'ERR_GENESIS_INVITE_NOT_CONFIGURED');
  }
});
