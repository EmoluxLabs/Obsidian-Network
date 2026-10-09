/**
 * scripts/obsidian-network.sh — one command per network.
 *
 * This runs the helper the way the Termux and VPS guides tell people to, on
 * shifted ports (OBSIDIAN_PORT_OFFSET) so it can run next to a real deployment.
 * What it must prove is the thing the helper exists for: each network has its
 * own ports, data and passphrase, and doing something to one never touches
 * another.
 *
 *   node --test tests/scripts/network-script.test.mjs
 *
 * Needs both packages built.
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const script = join(root, 'scripts', 'obsidian-network.sh');
const built = existsSync(join(root, 'obsidian-core', 'dist', 'index.js')) && existsSync(join(root, 'obsidian-interface', 'dist', 'server', 'main.js'));
const skip = !built ? 'build obsidian-core and obsidian-interface first' : process.platform === 'win32' ? 'bash only' : false;

const OFFSET = 700; // devnet 39330/39331/39488, testnet 19330/19331/19488
const home = mkdtempSync(join(tmpdir(), 'obsidian-netscript-'));
const baseEnv = { ...process.env, OBSIDIAN_HOME: home, OBSIDIAN_PORT_OFFSET: String(OFFSET) };
delete baseEnv.OBSIDIAN_KEYSTORE_PASSPHRASE;
delete baseEnv.OBSIDIAN_KEYSTORE_PASSPHRASE_FILE;
delete baseEnv.OBSIDIAN_GENESIS_INVITE_HASH;
delete baseEnv.OBSIDIAN_NETWORK;

const run = (args, env = {}) => spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...baseEnv, ...env }, timeout: 120_000 });
const ports = { devnet: { rpc: 38630 + OFFSET, ui: 38788 + OFFSET }, testnet: { rpc: 18630 + OFFSET, ui: 18788 + OFFSET } };
const get = async (url) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return { status: response.status, body: await response.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
};

after(() => {
  for (const network of ['devnet', 'testnet', 'mainnet']) run([network, 'stop']);
  rmSync(home, { recursive: true, force: true });
});

test('refuses a network that does not exist, and asks for one when none is given', { skip }, () => {
  const unknown = run(['moonnet', 'start']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown network "moonnet".*there is no default/);
  const none = run([]);
  assert.equal(none.status, 0);
  assert.match(none.stdout, /obsidian-network\.sh <network> <command>/);
  const noCommand = run(['devnet']);
  assert.equal(noCommand.status, 1);
});

test('mainnet will not invent a passphrase, and starts nothing without one', { skip }, async () => {
  const started = run(['mainnet', 'start']);
  assert.equal(started.status, 1);
  assert.match(started.stderr, /mainnet needs a passphrase YOU chose/);
  assert.equal(existsSync(join(home, 'mainnet', 'keystore.pass')), false);
  assert.equal(existsSync(join(home, 'mainnet', 'node.pid')), false);
  assert.equal((await get(`http://127.0.0.1:${8630 + OFFSET}/health`)).status, 0);
});

test('devnet: invite, start, use the invitation, stop — and the ports are free again', { skip }, async () => {
  const minted = run(['devnet', 'invite']);
  assert.equal(minted.status, 0, minted.stderr);
  const code = /OBS-GENESIS-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/.exec(minted.stdout)?.[0];
  assert.ok(code, `the code is printed once:\n${minted.stdout}`);
  const hashFile = join(home, 'devnet', 'genesis-invite.hash');
  assert.match(readFileSync(hashFile, 'utf8'), /^scrypt\$32768\$8\$1\$/);
  assert.equal((statSync(hashFile).mode & 0o777).toString(8), '600', 'the hash is not world-readable');
  assert.ok(!readFileSync(hashFile, 'utf8').includes(code), 'the code itself is stored nowhere');

  const started = run(['devnet', 'start']);
  assert.equal(started.status, 0, started.stderr + started.stdout);
  assert.match(started.stdout, new RegExp(`open the interface:  http://127.0.0.1:${ports.devnet.ui}`));
  // A test network gets a generated passphrase, in its own file.
  assert.match(readFileSync(join(home, 'devnet', 'keystore.pass'), 'utf8'), /\S{20,}/);

  // Protocol 1.7.0: the chain takes a claim only through the mining gate. A test network gets its own issuer key,
  // encrypted, with its passphrase in its own file; the node is given the PUBLIC half and the interface the keystore.
  const gateStore = join(home, 'devnet', 'gate', 'mining-gate.keystore.json');
  assert.equal((statSync(gateStore).mode & 0o777).toString(8), '600', 'the encrypted issuer key is not world-readable');
  const gateKeystore = JSON.parse(readFileSync(gateStore, 'utf8'));
  assert.match(gateKeystore.publicKey, /^0[23][0-9a-f]{64}$/);
  assert.ok(!/"privateKey"/.test(readFileSync(gateStore, 'utf8')), 'the private key is only ever stored encrypted');
  const gated = (await get(`http://127.0.0.1:${ports.devnet.rpc}/mining/status?address=dobs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rrs0ff0`)).body;
  assert.deepEqual(gated.gate.issuerKeys, [gateKeystore.publicKey], 'the node commits exactly the key the interface holds');
  assert.equal(gated.gate.open, true);
  assert.match(readFileSync(join(home, 'devnet', 'logs', 'interface.log'), 'utf8'), /mining gate issuer loaded/);

  const health = await get(`http://127.0.0.1:${ports.devnet.ui}/api/health`);
  assert.equal(health.body.network, 'devnet');
  assert.equal(health.body.healthyNodes, 1);
  assert.equal((await get(`http://127.0.0.1:${ports.devnet.rpc}/status`)).body.chainId, 7780);
  assert.deepEqual((await get(`http://127.0.0.1:${ports.devnet.ui}/api/auth/config`)).body.genesisInvite, { configured: true, redeemed: false });

  const registered = await fetch(`http://127.0.0.1:${ports.devnet.ui}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'founder-tester@gmail.com', password: 'a-long-passphrase-9', inviteCode: code }),
  });
  assert.equal(registered.status, 200);
  assert.equal((await registered.json()).bootstrapped, true);

  const status = run(['devnet', 'status']);
  assert.match(status.stdout, /network   : devnet/);
  assert.match(status.stdout, /node : running/);
  assert.match(status.stdout, /interface : running/);
  assert.match(status.stdout, /obsidian-devnet-1/);

  // Starting what is already running changes nothing.
  assert.match(run(['devnet', 'start']).stdout, /already running/);

  const stopped = run(['devnet', 'stop']);
  assert.equal(stopped.status, 0);
  assert.equal((await get(`http://127.0.0.1:${ports.devnet.rpc}/health`)).status, 0);
  assert.equal((await get(`http://127.0.0.1:${ports.devnet.ui}/api/health`)).status, 0);
});

test('two networks at once: stopping one never touches the other', { skip }, async () => {
  const devnet = run(['devnet', 'start']);
  assert.equal(devnet.status, 0, devnet.stderr);
  const testnet = run(['testnet', 'start']);
  assert.equal(testnet.status, 0, testnet.stderr);

  assert.equal((await get(`http://127.0.0.1:${ports.devnet.rpc}/status`)).body.networkId, 'obsidian-devnet-1');
  assert.equal((await get(`http://127.0.0.1:${ports.testnet.rpc}/status`)).body.networkId, 'obsidian-testnet-1');
  assert.equal((await get(`http://127.0.0.1:${ports.testnet.ui}/api/health`)).body.network, 'testnet');
  // Different data, different passphrase files.
  assert.notEqual(readFileSync(join(home, 'devnet', 'keystore.pass'), 'utf8'), readFileSync(join(home, 'testnet', 'keystore.pass'), 'utf8'));
  assert.ok(existsSync(join(home, 'devnet', 'node', 'chain')) && existsSync(join(home, 'testnet', 'node', 'chain')));

  assert.equal(run(['devnet', 'stop']).status, 0);
  assert.equal((await get(`http://127.0.0.1:${ports.devnet.rpc}/health`)).status, 0, 'devnet is down');
  assert.equal((await get(`http://127.0.0.1:${ports.testnet.rpc}/health`)).status, 200, 'testnet is untouched');
  assert.equal((await get(`http://127.0.0.1:${ports.testnet.ui}/api/health`)).status, 200);

  assert.equal(run(['testnet', 'stop']).status, 0);
  assert.equal((await get(`http://127.0.0.1:${ports.testnet.rpc}/health`)).status, 0);
});

test('reset deletes one test network only, only when told to, never mainnet', { skip }, () => {
  assert.match(run(['mainnet', 'reset', '--yes']).stderr, /refused for mainnet/);
  const unconfirmed = run(['devnet', 'reset']);
  assert.equal(unconfirmed.status, 1);
  assert.match(unconfirmed.stderr, /Run again with --yes/);
  assert.ok(existsSync(join(home, 'devnet', 'node')), 'nothing was deleted without --yes');
  const done = run(['devnet', 'reset', '--yes']);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(existsSync(join(home, 'devnet', 'node')), false);
  assert.ok(existsSync(join(home, 'devnet', 'keystore.pass')), 'the passphrase file is kept');
  assert.ok(existsSync(join(home, 'devnet', 'genesis-invite.hash')), 'the invitation hash is kept');
  assert.ok(existsSync(join(home, 'testnet', 'node')), 'the other network is untouched');
});

test('wallet new prints an address for the requested network only', { skip }, () => {
  for (const [network, prefix] of [['devnet', 'dobs1'], ['testnet', 'tobs1'], ['staging', 'sobs1'], ['mainnet', 'obs1']]) {
    const out = run([network, 'wallet']);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, new RegExp(`"address": "${prefix}`));
    assert.match(out.stdout, /"recoveryPhrase"/);
  }
});

// ── what a person actually runs into ─────────────────────────────────────────
//
// The tests above run each network in a clean shell. A person does not: they run devnet, then testnet, in the
// same Termux session, with whatever the earlier blocks of the guide left exported. These reproduce that.

const homes = [];
const freshHome = () => {
  const dir = mkdtempSync(join(tmpdir(), 'obsidian-netscript-x-'));
  homes.push(dir);
  return dir;
};
const runIn = (dir, args, env = {}) => spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...baseEnv, OBSIDIAN_HOME: dir, ...env }, timeout: 120_000 });
const stopAll = (dir) => {
  for (const network of ['devnet', 'testnet', 'staging', 'mainnet']) runIn(dir, [network, 'stop']);
};
after(() => {
  for (const dir of homes) {
    stopAll(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});
const uiPort = { devnet: 38788 + OFFSET, testnet: 18788 + OFFSET, staging: 28788 + OFFSET, mainnet: 8788 + OFFSET };
const rpcPort = { devnet: 38630 + OFFSET, testnet: 18630 + OFFSET, staging: 28630 + OFFSET, mainnet: 8630 + OFFSET };
const SHIPPED = /DEVNET_SHIPPED_INVITE_HASH='([^']+)'/.exec(readFileSync(script, 'utf8'))?.[1];
const register = (network, code, email) =>
  fetch(`http://127.0.0.1:${uiPort[network]}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'a-long-passphrase-9', inviteCode: code }),
  });
const inviteConfig = async (network) => (await get(`http://127.0.0.1:${uiPort[network]}/api/auth/config`)).body?.genesisInvite;
const said = (result) => `${result.stdout}\n${result.stderr}`;

test('the devnet invitation that ships with the release is used when nothing is exported', { skip }, async () => {
  assert.match(SHIPPED ?? '', /^scrypt\$32768\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/, 'the helper carries the shipped hash');
  const dir = freshHome();
  try {
    const started = runIn(dir, ['devnet', 'start']);
    assert.equal(started.status, 0, said(started));
    assert.match(started.stdout, /disposable Genesis Invitation that ships with this release/);
    assert.deepEqual(await inviteConfig('devnet'), { configured: true, redeemed: false });
    assert.equal(existsSync(join(dir, 'devnet', 'genesis-invite.hash')), false, 'nothing was written: the default is not an invitation of the user\'s own');
  } finally {
    stopAll(dir);
  }
});

test('devnet\'s invitation never opens another network, however it got into the shell', { skip }, async () => {
  // The devnet block of the guide used to `export` this hash, and it stays in the shell.
  const dir = freshHome();
  try {
    const minted = runIn(dir, ['testnet', 'invite'], { OBSIDIAN_GENESIS_INVITE_HASH: SHIPPED });
    const code = /OBS-GENESIS-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/.exec(minted.stdout)?.[0];
    assert.ok(code, minted.stdout + minted.stderr);
    const ownHash = readFileSync(join(dir, 'testnet', 'genesis-invite.hash'), 'utf8');
    assert.notEqual(ownHash, SHIPPED);

    const started = runIn(dir, ['testnet', 'start'], { OBSIDIAN_GENESIS_INVITE_HASH: SHIPPED });
    assert.equal(started.status, 0, said(started));
    assert.match(started.stdout, /ignoring OBSIDIAN_GENESIS_INVITE_HASH from your shell: that is devnet's invitation/);
    // The code testnet's own `invite` printed opens testnet; before, the devnet hash overrode it and this was refused.
    const registered = await register('testnet', code, 'founder-tester@gmail.com');
    assert.equal(registered.status, 200, 'testnet\'s own invitation works');
    runIn(dir, ['testnet', 'stop']);

    // And with no invitation of its own, a network is left unconfigured rather than opened by devnet's.
    const staging = runIn(dir, ['staging', 'start'], { OBSIDIAN_GENESIS_INVITE_HASH: SHIPPED });
    assert.equal(staging.status, 0, said(staging));
    assert.match(staging.stdout, /ignoring OBSIDIAN_GENESIS_INVITE_HASH/);
    assert.deepEqual(await inviteConfig('staging'), { configured: false, redeemed: false });
  } finally {
    stopAll(dir);
  }
});

test('a passphrase left in the shell cannot lock a node out of its own key, or protect a new one', { skip }, async () => {
  const dir = freshHome();
  try {
    assert.equal(runIn(dir, ['devnet', 'start']).status, 0);
    runIn(dir, ['devnet', 'stop']);
    // Exported "by hand" for something else, then the helper: this used to kill the node ("could not decrypt the keystore").
    const again = runIn(dir, ['devnet', 'start'], { OBSIDIAN_KEYSTORE_PASSPHRASE: 'something-else-entirely' });
    assert.equal(again.status, 0, said(again));
    assert.match(again.stdout, /ignoring the passphrase in your shell: this devnet node's key uses the one in/);
    assert.equal((await get(`http://127.0.0.1:${rpcPort.devnet}/status`)).body.chainId, 7780);
    runIn(dir, ['devnet', 'stop']);

    // A new test-network key gets its own passphrase even when the shell holds one, so it opens later without it.
    const created = runIn(dir, ['staging', 'start'], { OBSIDIAN_KEYSTORE_PASSPHRASE: 'left-over-from-mainnet' });
    assert.equal(created.status, 0, said(created));
    assert.match(created.stdout, /a new staging key gets its own generated passphrase/);
    assert.ok(existsSync(join(dir, 'staging', 'keystore.pass')));
    runIn(dir, ['staging', 'stop']);
    assert.equal(runIn(dir, ['staging', 'start']).status, 0, 'the key opens in a new session, with nothing in the shell');
  } finally {
    stopAll(dir);
  }
});

test('a key made by hand opens only with the passphrase it was made with, and the refusal says what to do', { skip }, async () => {
  const dir = freshHome();
  try {
    const core = join(root, 'obsidian-core');
    // Start a staging node by hand, the way "the same thing by hand" in the guide does, long enough to make its key.
    spawnSync(process.execPath, ['dist/index.js', 'start', '--network', 'staging', '--data-dir', join(dir, 'staging', 'node'), '--rpc-port', '59930', '--p2p-port', '59931', '--log-level', 'warn'], {
      cwd: core,
      env: { ...baseEnv, OBSIDIAN_KEYSTORE_PASSPHRASE: 'a-passphrase-made-by-hand' },
      timeout: 6_000,
    });
    assert.ok(existsSync(join(dir, 'staging', 'node', 'node-key.json')), 'the by-hand node made its key');

    const none = runIn(dir, ['staging', 'start']);
    assert.equal(none.status, 1);
    assert.match(none.stderr, /already has a key.*started by hand.*OBSIDIAN_KEYSTORE_PASSPHRASE=/s);

    const wrong = runIn(dir, ['staging', 'start'], { OBSIDIAN_KEYSTORE_PASSPHRASE: 'a-different-passphrase' });
    assert.equal(wrong.status, 1);
    assert.match(said(wrong), /could not decrypt the node keystore/);
    assert.match(said(wrong), /made with a different passphrase than the one it was given/);

    const right = runIn(dir, ['staging', 'start'], { OBSIDIAN_KEYSTORE_PASSPHRASE: 'a-passphrase-made-by-hand' });
    assert.equal(right.status, 0, said(right));
    assert.equal((await get(`http://127.0.0.1:${rpcPort.staging}/status`)).body.chainId, 7779);
  } finally {
    stopAll(dir);
  }
});

test('a leftover OBSIDIAN_NETWORK in the shell does not stop another network from starting', { skip }, async () => {
  const dir = freshHome();
  try {
    const started = runIn(dir, ['testnet', 'start'], { OBSIDIAN_NETWORK: 'devnet', OBSIDIAN_INTERFACE_NETWORK: 'devnet' });
    assert.equal(started.status, 0, said(started));
    assert.match(started.stdout, /ignoring OBSIDIAN_NETWORK=devnet from your shell: this command is for testnet/);
    assert.match(started.stdout, /ignoring OBSIDIAN_INTERFACE_NETWORK=devnet/);
    assert.equal((await get(`http://127.0.0.1:${rpcPort.testnet}/status`)).body.chainId, 7778, 'it is testnet, not what the shell said');
    runIn(dir, ['testnet', 'stop']);
    // The same network named by the shell is no news.
    const same = runIn(dir, ['testnet', 'start'], { OBSIDIAN_NETWORK: 'testnet' });
    assert.equal(same.status, 0, said(same));
    assert.doesNotMatch(same.stdout, /ignoring OBSIDIAN_NETWORK/);
  } finally {
    stopAll(dir);
  }
});

test('peers named in the shell are announced, and one on another network\'s usual port is flagged', { skip }, () => {
  const dir = freshHome();
  try {
    const started = runIn(dir, ['devnet', 'start'], { OBSIDIAN_SEED_NODES: '203.0.113.10:8631', OBSIDIAN_NODE_ONLY: '1' });
    assert.equal(started.status, 0, said(started));
    assert.match(started.stdout, /dialling the peers in OBSIDIAN_SEED_NODES: 203\.0\.113\.10:8631/);
    assert.match(started.stdout, /warning: 203\.0\.113\.10:8631 uses mainnet's usual P2P port but this is devnet/);
    assert.match(started.stdout, /env -u OBSIDIAN_SEED_NODES/);
  } finally {
    stopAll(dir);
  }
});

test('what is still running from before an upgrade is called out, not silently reused', { skip }, () => {
  const dir = freshHome();
  try {
    assert.equal(runIn(dir, ['devnet', 'start']).status, 0);
    // "Started a week ago": the installed files are newer than the process that is running them.
    const longAgo = new Date(Date.now() - 7 * 86_400_000);
    for (const pid of ['node.pid', 'interface.pid']) utimesSync(join(dir, 'devnet', pid), longAgo, longAgo);

    const again = runIn(dir, ['devnet', 'start']);
    assert.equal(again.status, 0, said(again));
    assert.match(again.stdout, /devnet node is already running/);
    assert.match(again.stdout, /this node was started BEFORE the build that is installed now.*restart/s);
    assert.match(again.stdout, /this interface was started BEFORE the build that is installed now/);
    assert.match(runIn(dir, ['devnet', 'status']).stdout, /started BEFORE the build that is installed now/);
    assert.match(runIn(dir, ['devnet', 'doctor']).stdout, /started BEFORE the build that is installed now/);

    // A restart makes it current, and the note goes away.
    const restarted = runIn(dir, ['devnet', 'restart']);
    assert.equal(restarted.status, 0, said(restarted));
    assert.doesNotMatch(runIn(dir, ['devnet', 'start']).stdout, /started BEFORE/);
  } finally {
    stopAll(dir);
  }
});

test('doctor says what is wrong, in words, and exits non-zero only when something is', { skip }, async () => {
  const dir = freshHome();
  try {
    const clean = runIn(dir, ['devnet', 'doctor']);
    assert.equal(clean.status, 0, said(clean));
    for (const heading of ['this machine', 'the installed build', "this network's data and ports", 'what is running', 'keys, passphrases and the invitation', 'your shell', 'recent errors']) {
      assert.ok(clean.stdout.includes(heading), `doctor reports "${heading}"`);
    }
    assert.match(clean.stdout, /no problems found/);
    assert.match(clean.stdout, /the disposable devnet one that ships with the release/);

    // A port taken by something else is a problem, and the fix is on the next line.
    const squatter = createServer();
    await new Promise((resolvePromise) => squatter.listen(uiPort.devnet, '127.0.0.1', resolvePromise));
    try {
      const taken = runIn(dir, ['devnet', 'doctor']);
      assert.equal(taken.status, 1);
      assert.match(taken.stdout, new RegExp(`PROBLEM  interface ${uiPort.devnet} is in use by something else`));
      assert.match(taken.stdout, /OBSIDIAN_PORT_OFFSET=10/);
      assert.match(taken.stdout, /1 problem\(s\) above/);
    } finally {
      await new Promise((resolvePromise) => squatter.close(resolvePromise));
    }

    // Leftovers in the shell are listed, with what is done about each.
    const leftovers = runIn(dir, ['testnet', 'doctor'], { OBSIDIAN_NETWORK: 'devnet', OBSIDIAN_SEED_NODES: '203.0.113.10:8631', OBSIDIAN_GENESIS_INVITE_HASH: SHIPPED });
    assert.equal(leftovers.status, 0, said(leftovers));
    assert.match(leftovers.stdout, /ignored for this network: OBSIDIAN_NETWORK=devnet/);
    assert.match(leftovers.stdout, /OBSIDIAN_GENESIS_INVITE_HASH is devnet's: used on devnet, never on another network/);
    assert.match(leftovers.stdout, /OBSIDIAN_SEED_NODES=203\.0\.113\.10:8631/);
    assert.match(leftovers.stdout, /invitation: none yet.*testnet invite/s);

    // A running network owns its ports.
    assert.equal(runIn(dir, ['devnet', 'start']).status, 0);
    const running = runIn(dir, ['devnet', 'doctor']);
    assert.equal(running.status, 0, said(running));
    assert.match(running.stdout, /node RPC \d+ is held by this network's own process/);
    assert.match(running.stdout, /passphrase: this network's own file/);
  } finally {
    stopAll(dir);
  }
});

test('it runs with only the tools a fresh Termux has', { skip }, async () => {
  // Termux ships a small userland. What the helper does not need must not sneak in: no ss, lsof, setsid,
  // openssl, python3, jq or pgrep, and its own private home and temp directories.
  const dir = freshHome();
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const termux = 'sh env cat cp mv rm mkdir rmdir ls chmod ln touch head tail cut tr sort uniq wc tee sed grep awk find xargs tar gzip date sleep dirname basename readlink realpath mktemp uname id whoami stat du df od base64 sha256sum expr seq timeout tty stty nohup node'.split(' ');
  for (const tool of termux) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (found) symlinkSync(realpathSync(found), join(bin, tool));
  }
  for (const absent of ['ss', 'netstat', 'lsof', 'setsid', 'openssl', 'python3', 'python', 'jq', 'pgrep', 'pkill', 'curl', 'hostname', 'ip']) {
    assert.equal(existsSync(join(bin, absent)), false, `${absent} must not be on the stand-in's PATH`);
  }
  const bash = realpathSync(spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim());
  symlinkSync(bash, join(bin, 'bash'));
  const home = join(dir, 'home');
  const tmp = join(dir, 'tmp');
  mkdirSync(home);
  mkdirSync(tmp);
  const termuxRun = (args) => spawnSync(bash, [script, ...args], { encoding: 'utf8', timeout: 120_000, env: { PATH: bin, HOME: home, TMPDIR: tmp, OBSIDIAN_PORT_OFFSET: String(OFFSET) } });
  try {
    const started = termuxRun(['devnet', 'start']);
    assert.equal(started.status, 0, said(started));
    assert.match(started.stdout, /devnet is up/);
    assert.equal((await get(`http://127.0.0.1:${rpcPort.devnet}/status`)).body.chainId, 7780);
    assert.match(termuxRun(['devnet', 'status']).stdout, /node : running/);
    const doctor = termuxRun(['devnet', 'doctor']);
    assert.equal(doctor.status, 0, said(doctor));
    assert.match(doctor.stdout, /no problems found/);
    assert.equal(termuxRun(['devnet', 'stop']).status, 0);
    assert.equal((await get(`http://127.0.0.1:${rpcPort.devnet}/health`)).status, 0);
    assert.ok(existsSync(join(home, 'obsidian-data', 'devnet', 'node')), 'its data went to the stand-in home, not /tmp or the real one');
  } finally {
    termuxRun(['devnet', 'stop']);
  }
});

test('the helper never writes outside its data directory and the places it was told about', { skip }, () => {
  const text = readFileSync(script, 'utf8');
  assert.ok(!/\/tmp\b/.test(text.replace(/^#.*$/gm, '')), 'Termux has no /tmp: nothing may be written there');
  for (const tool of ['ss ', 'lsof', 'setsid', 'openssl', 'python', 'jq ', 'pgrep', 'pkill', 'netstat']) {
    assert.ok(!new RegExp(`(^|[|;&(\`]|\\$\\()\\s*${tool.trim()}\\b`, 'm').test(text.replace(/^\s*#.*$/gm, '')), `the helper must not call ${tool.trim()}: a fresh Termux does not have it`);
  }
});
