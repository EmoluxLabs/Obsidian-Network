/**
 * Interface failover with REAL processes: three interface servers (two primary-capable, one edge), one shared
 * account store, one lease. Leaders are killed with SIGKILL, frozen with SIGSTOP (a partition / long pause that the
 * victim cannot observe) and restarted; every claim below is observed over HTTP and on the shared file.
 *
 *   node --test tests/e2e/failover.test.mjs
 *   SKIP_E2E=1 node --test tests/e2e/failover.test.mjs
 *
 * Needs `npm --prefix obsidian-interface run build`. No chain is involved: a stub node answers /status so the
 * interfaces report ready. What is NOT covered here: DNS, TLS, a durable multi-machine database (see
 * docs/failover-and-gateways.md).
 */
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { after, before } from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IFACE = join(ROOT, 'obsidian-interface');
const ENTRY = join(IFACE, 'dist', 'server', 'main.js');
const skip = process.env.SKIP_E2E === '1' ? 'SKIP_E2E=1' : !existsSync(ENTRY) || !existsSync(join(IFACE, 'dist', 'server', 'lease.js')) ? 'build obsidian-interface first' : false;

const PORTS = { a: 49310, b: 49311, edge: 49312 };
const url = (name) => `http://127.0.0.1:${PORTS[name]}`;
const PASSWORD = 'correct-horse-7-battery';
const TTL = 3000;
const SKEW = 250;

const children = new Map();
const everyChild = []; // including replaced ones, so nothing outlives the test
const dirs = [];
let stub;
let data;
let genesis;

const scratch = (label) => {
  const dir = mkdtempSync(join(tmpdir(), `obsidian-ha-${label}-`));
  dirs.push(dir);
  return dir;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(target, init) {
  const response = await fetch(target, { ...init, signal: AbortSignal.timeout(4000) });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}
const post = (target, body, cookie) =>
  get(target, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });

function launch(name, extra = {}, dataDir = data) {
  const env = {
    ...process.env,
    OBSIDIAN_NODE_ONLY: '1',
    OBSIDIAN_INTERFACE_DATA_DIR: dataDir,
    OBSIDIAN_GENESIS_INVITE_HASH: genesis.hash,
    OBSIDIAN_INTERFACE_LEASE_TTL_MS: String(TTL),
    OBSIDIAN_INTERFACE_MAX_CLOCK_SKEW_MS: String(SKEW),
    ...extra,
  };
  const child = spawn(process.execPath, [ENTRY, '--network', 'devnet', '--port', String(PORTS[name]), '--nodes', stub.url, '--data-dir', dataDir], { cwd: IFACE, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const record = { child, log: [], exited: false };
  child.stdout.on('data', (c) => record.log.push(c.toString()));
  child.stderr.on('data', (c) => record.log.push(c.toString()));
  child.on('exit', () => (record.exited = true));
  children.set(name, record);
  everyChild.push(record);
  return record;
}
const primaryEnv = (name) => ({
  OBSIDIAN_INTERFACE_LEASE_DIR: join(data, 'lease'),
  OBSIDIAN_INTERFACE_ADVERTISE_URL: url(name),
});

async function waitFor(condition, timeout, what) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await condition();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (${last.message})` : ''}`);
}
const ready = (name) => get(`${url(name)}/api/ready`).then((r) => r.body);
const state = async (name) => (await ready(name)).leader?.state;
const accountsOnDisk = () => JSON.parse(readFileSync(join(data, 'interface-accounts.json'), 'utf8')).accounts;

before(async () => {
  if (skip) return;
  const { newGenesisInvitation } = await import(pathToFileURL(join(IFACE, 'dist', 'server', 'genesis-invite.js')).href);
  genesis = newGenesisInvitation();
  data = scratch('shared');
  stub = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ height: 1, headHash: 'ab', genesisId: 'g', chainId: 7780, networkId: 'obsidian-devnet-1', syncing: false, peers: 1 }));
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  stub.url = `http://127.0.0.1:${stub.address().port}`;
});

after(() => {
  for (const record of everyChild) if (!record.exited) record.child.kill('SIGKILL');
  stub?.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

let cookie;
let invites = [];

test('one host becomes the leader, the other is a standby that fails closed', { skip, timeout: 60_000 }, async () => {
  launch('a', primaryEnv('a'));
  await waitFor(async () => (await state('a')) === 'leader', 20_000, 'host A to take the lease');
  launch('b', primaryEnv('b'));
  await waitFor(async () => (await state('b')) === 'standby', 20_000, 'host B to settle as standby');

  const probe = await post(`${url('b')}/api/auth/register`, { email: 'standby-probe@gmail.com', password: PASSWORD, inviteCode: genesis.code });
  assert.equal(probe.status, 503);
  assert.equal(probe.body.code, 'ERR_NOT_LEADER');
  assert.equal(probe.headers.get('x-obsidian-standby'), '1');
  assert.equal(existsSync(join(data, 'interface-accounts.json')) ? accountsOnDisk().length : 0, 0, 'a standby must not have written an account');
  const readyB = await get(`${url('b')}/api/ready`);
  assert.equal(readyB.status, 503, 'a standby is not ready for account traffic');
  assert.equal((await get(`${url('b')}/api/health`)).status, 200, 'but it is alive');
  assert.equal((await ready('a')).leader.token, 1);
});

test('accounts are created on the leader; the standby still refuses every stateful route', { skip, timeout: 60_000 }, async () => {
  const created = await post(`${url('a')}/api/auth/register`, { email: 'first-tester@gmail.com', password: PASSWORD, inviteCode: genesis.code });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  cookie = created.headers.get('set-cookie').split(';')[0];
  for (let i = 0; i < 3; i += 1) {
    const invite = await post(`${url('a')}/api/auth/invites`, {}, cookie);
    assert.equal(invite.status, 201);
    invites.push(invite.body.invite.code);
  }
  for (const route of ['/api/auth/me', '/api/auth/invites', '/api/wallet/link/challenge', '/api/mining/certificate']) {
    const answer = route === '/api/auth/me' || route === '/api/auth/invites' ? await get(`${url('b')}${route}`, { headers: { cookie } }) : await post(`${url('b')}${route}`, {}, cookie);
    assert.equal(answer.status, 503, route);
    assert.equal(answer.body.code, 'ERR_NOT_LEADER', route);
  }
  assert.equal(accountsOnDisk().length, 1);
});

test('an edge host: refuses accounts, names the current leader, and never gets an account store', { skip, timeout: 60_000 }, async () => {
  const edgeData = scratch('edge');
  launch('edge', { OBSIDIAN_INTERFACE_ROLE: 'edge', OBSIDIAN_INTERFACE_PRIMARY_URLS: `${url('a')},${url('b')}`, OBSIDIAN_GENESIS_INVITE_HASH: '' }, edgeData);
  await waitFor(async () => (await ready('edge')).primary?.url === url('a'), 20_000, 'the edge to discover the leader');
  const answer = await get(`${url('edge')}/api/auth/me`, { headers: { cookie } });
  assert.equal(answer.status, 503);
  assert.equal(answer.body.code, 'ERR_EDGE_READ_ONLY');
  assert.equal(answer.body.primary, url('a'));
  assert.equal(existsSync(join(edgeData, 'interface-accounts.json')), false);
  assert.equal(existsSync(join(edgeData, 'lease')), false, 'an edge never touches a lease');
  // And an edge refuses to be configured with the shared volume at all.
  const bad = spawn(process.execPath, [ENTRY, '--network', 'devnet', '--port', '49319', '--nodes', stub.url], { cwd: IFACE, env: { ...process.env, OBSIDIAN_NODE_ONLY: '1', OBSIDIAN_INTERFACE_ROLE: 'edge', OBSIDIAN_INTERFACE_LEASE_DIR: join(data, 'lease') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  bad.stderr.on('data', (c) => (stderr += c));
  const code = await new Promise((r) => bad.on('exit', r));
  assert.equal(code, 2);
  assert.match(stderr, /edge must never be given the shared account/);
});

test('SIGKILL the leader under load: standby takes over with a higher token, the session survives, no request is wrongly answered', { skip, timeout: 90_000 }, async () => {
  await sleep(2600); // sessions are flushed within ~2 s by design; a crash inside that window costs a re-login
  const before = JSON.parse(readFileSync(join(data, 'lease', 'lease.json'), 'utf8'));
  assert.equal(before.token, 1);
  const outcomes = [];
  let stopLoad = false;
  const load = (async () => {
    while (!stopLoad) {
      for (const name of ['a', 'b']) {
        if (children.get(name)?.exited) continue;
        try {
          const r = await get(`${url(name)}/api/auth/me`, { headers: { cookie } });
          outcomes.push({ name, status: r.status, code: r.body?.code, email: r.body?.account?.email });
        } catch {
          outcomes.push({ name, status: 0 });
        }
      }
      await sleep(50);
    }
  })();
  children.get('a').child.kill('SIGKILL');
  await waitFor(async () => (await state('b')) === 'leader', 30_000, 'host B to take over');
  await sleep(300);
  stopLoad = true;
  await load;
  const token = (await ready('b')).leader.token;
  assert.equal(token, 2, 'the fencing token advanced');
  const unexpected = outcomes.filter((o) => ![0, 200, 503].includes(o.status) || (o.status === 503 && o.code !== 'ERR_NOT_LEADER' && o.name === 'b'));
  assert.deepEqual(unexpected, [], 'only success, unreachable or a retryable ERR_NOT_LEADER');
  const afterTakeover = await get(`${url('b')}/api/auth/me`, { headers: { cookie } });
  assert.equal(afterTakeover.status, 200, 'the session issued by the dead leader works on the new one');
  assert.equal(accountsOnDisk().length, 1);
});

test('restart the dead host: it comes back as a standby (the lease is not its anymore) and cannot write', { skip, timeout: 60_000 }, async () => {
  launch('a', primaryEnv('a'));
  await waitFor(async () => (await state('a')) === 'standby', 20_000, 'restarted A to stand by');
  const refused = await post(`${url('a')}/api/auth/register`, { email: 'late-tester@gmail.com', password: PASSWORD, inviteCode: invites[0] });
  assert.equal(refused.status, 503);
  assert.equal(accountsOnDisk().length, 1);
  assert.equal((await ready('b')).leader.token, 2, 'a restart does not bump the token while the leader is healthy');
});

test('a duplicate registration through the leader is rejected, and a replayed invite is not honoured twice', { skip, timeout: 60_000 }, async () => {
  const first = await post(`${url('b')}/api/auth/register`, { email: 'second-tester@gmail.com', password: PASSWORD, inviteCode: invites[0] });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const again = await post(`${url('b')}/api/auth/register`, { email: 'second-tester@gmail.com', password: PASSWORD, inviteCode: invites[1] });
  assert.notEqual(again.status, 200, 'the same mailbox cannot create a second account');
  const replay = await post(`${url('b')}/api/auth/register`, { email: 'third-tester@gmail.com', password: PASSWORD, inviteCode: invites[0] });
  assert.notEqual(replay.status, 200, 'a spent invite is spent');
  assert.equal(accountsOnDisk().length, 2);
});

test('SPLIT BRAIN: freeze the leader (SIGSTOP), let the standby take over, resume the old leader: it cannot write', { skip, timeout: 120_000 }, async () => {
  const frozen = children.get('b');
  frozen.child.kill('SIGSTOP');
  try {
    await waitFor(async () => (await state('a')) === 'leader', 40_000, 'A to take the lease from the frozen B');
  } finally {
    frozen.child.kill('SIGCONT');
  }
  assert.equal((await ready('a')).leader.token, 3);
  const before = readFileSync(join(data, 'interface-accounts.json'), 'utf8');

  // B just woke up. Whatever it believes for the next instant, every attempt it makes must be refused...
  const attempts = [];
  for (let i = 0; i < 6; i += 1) attempts.push(post(`${url('b')}/api/auth/register`, { email: `ghost-${i}-tester@gmail.com`, password: PASSWORD, inviteCode: invites[1] }));
  const answers = await Promise.all(attempts);
  for (const answer of answers) assert.equal(answer.status, 503, JSON.stringify(answer.body));
  // ...and while that happened, the real leader kept working.
  const real = await post(`${url('a')}/api/auth/register`, { email: 'fourth-tester@gmail.com', password: PASSWORD, inviteCode: invites[1] });
  assert.equal(real.status, 200, JSON.stringify(real.body));
  const emails = accountsOnDisk().map((a) => a.email ?? a.canonicalEmail);
  assert.equal(emails.some((e) => String(e).includes('ghost')), false, 'nothing written by the deposed leader');
  assert.equal(accountsOnDisk().length, 3);
  assert.notEqual(readFileSync(join(data, 'interface-accounts.json'), 'utf8'), before);
  await waitFor(async () => (await state('b')) === 'standby', 20_000, 'the woken host to report standby');
  // The token the lease ended with is the one the live leader holds; never two leaders at once.
  const states = [await state('a'), await state('b')];
  assert.deepEqual(states.sort(), ['leader', 'standby']);
});

test('no secrets in any process log', { skip }, () => {
  for (const [name, record] of children) {
    const text = record.log.join('');
    assert.equal(text.includes(PASSWORD), false, `${name} logged a password`);
    assert.equal(text.includes(genesis.code), false, `${name} logged the genesis invitation`);
    assert.equal(/set-cookie|obsidian_session=/i.test(text), false, `${name} logged a session cookie`);
  }
});
