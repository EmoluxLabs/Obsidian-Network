/**
 * The node's passphrase prompt, on a real pseudo-terminal (protocol 1.9.0).
 *
 * With no OBSIDIAN_KEYSTORE_PASSPHRASE the node asks on the terminal, twice for a new key, and echoes nothing; it
 * keeps no passphrase file anywhere. Needs a built core and python3 (for a pty); skips cleanly otherwise.
 *
 *   node --test tests/scripts/keystore-prompt.test.mjs
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const core = join(root, 'obsidian-core');
const python = spawnSync('python3', ['-c', 'import pty'], { encoding: 'utf8' });
const skip = !existsSync(join(core, 'dist', 'index.js')) ? 'build obsidian-core first' : python.status !== 0 ? 'python3 pty not available' : false;

const DRIVER = `
import os, pty, select, sys, time
data_dir, secret = sys.argv[1], sys.argv[2]
env = {k: v for k, v in os.environ.items() if not k.startswith('OBSIDIAN_KEYSTORE')}
pid, fd = pty.fork()
if pid == 0:
    os.chdir(sys.argv[3])
    os.execvpe('node', ['node', 'dist/index.js', 'start', '--network', 'devnet', '--data-dir', data_dir, '--rpc-port', '39790', '--p2p-port', '39791', '--no-interface', '--log-level', 'error'], env)
seen = b''
def pump(seconds):
    global seen
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try: seen += os.read(fd, 4096)
            except OSError: return
pump(4); os.write(fd, secret.encode() + b'\\r')
pump(2); os.write(fd, secret.encode() + b'\\r')
pump(6)
os.kill(pid, 15)
text = seen.decode(errors='replace')
print('PROMPTED' if 'Choose a passphrase' in text and 'Type it again' in text else 'NO-PROMPT')
print('LEAKED' if text.replace(secret + '\\r\\n', '').count(secret) else 'NOT-ECHOED')
`;

test('the node asks for a passphrase on the terminal, echoes nothing, and keeps nothing', { skip, timeout: 60_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'obsidian-prompt-'));
  try {
    const secret = 'typed-at-the-prompt-1';
    const out = spawnSync('python3', ['-c', DRIVER, join(dir, 'node'), secret, core], { encoding: 'utf8', timeout: 45_000 });
    assert.match(out.stdout, /PROMPTED/, out.stdout + out.stderr);
    assert.match(out.stdout, /NOT-ECHOED/);
    assert.ok(existsSync(join(dir, 'node', 'node-key.json')), 'the key was created with the typed passphrase');
    const all = readdirSync(dir, { recursive: true }).map(String);
    assert.deepEqual(all.filter((name) => name.endsWith('.pass')), [], 'no passphrase file was written');
  } finally {
    spawnSync('pkill', ['-f', join(dir, 'node')]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without a terminal and without a passphrase the node refuses to start and creates no key', { skip: !existsSync(join(core, 'dist', 'index.js')) ? 'build obsidian-core first' : false, timeout: 30_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'obsidian-noprompt-'));
  try {
    const env = { ...process.env };
    delete env.OBSIDIAN_KEYSTORE_PASSPHRASE;
    delete env.OBSIDIAN_KEYSTORE_PASSPHRASE_FILE;
    const run = spawnSync(process.execPath, ['dist/index.js', 'start', '--network', 'devnet', '--data-dir', join(dir, 'node'), '--rpc-port', '39792', '--p2p-port', '39793', '--no-interface'], { cwd: core, env, encoding: 'utf8', input: '', timeout: 20_000 });
    assert.notEqual(run.status, 0);
    assert.match(run.stdout + run.stderr, /never generates a passphrase or stores one beside the keystore/);
    assert.equal(existsSync(join(dir, 'node', 'node-key.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
