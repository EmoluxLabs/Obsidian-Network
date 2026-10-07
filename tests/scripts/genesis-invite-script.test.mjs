/**
 * scripts/new-genesis-invite.mjs
 *
 * The code it prints is the only key to a fresh deployment, so what matters is
 * that the HASH it prints really belongs to the CODE it prints — checked through
 * the interface's own verifier, not through a copy of the algorithm.
 *
 * Needs the interface built (`npm --prefix obsidian-interface run build`); the
 * tests skip, loudly, when it is not.
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const script = join(root, 'scripts', 'new-genesis-invite.mjs');
const built = join(root, 'obsidian-interface', 'dist', 'server', 'genesis-invite.js');
const skip = existsSync(built) ? false : 'the interface is not built';

test('--json prints a code and a hash that belong together', { skip }, async () => {
  const run = spawnSync(process.execPath, [script, '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const { code, hash } = JSON.parse(run.stdout);
  const { verifyGenesisInvitation, looksLikeGenesisCode } = await import(pathToFileURL(built).href);
  assert.match(code, /^OBS-GENESIS-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.ok(looksLikeGenesisCode(code));
  assert.match(hash, /^scrypt\$32768\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.equal(verifyGenesisInvitation(code, hash), true);
  // The way a person actually types it back.
  assert.equal(verifyGenesisInvitation(code.toLowerCase().replaceAll('-', ' '), hash), true);
  assert.equal(verifyGenesisInvitation(`${code.slice(0, -1)}${code.endsWith('A') ? 'B' : 'A'}`, hash), false);
});

test('two runs never produce the same invitation', { skip }, () => {
  const once = () => JSON.parse(spawnSync(process.execPath, [script, '--json'], { encoding: 'utf8' }).stdout);
  const a = once();
  const b = once();
  assert.notEqual(a.code, b.code);
  assert.notEqual(a.hash, b.hash);
});

test('the human form shows the code once and tells the operator to configure the HASH', { skip }, () => {
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /OBS-GENESIS-/);
  assert.match(run.stdout, /export OBSIDIAN_GENESIS_INVITE_HASH='scrypt\$/);
  assert.match(run.stdout, /single use/i);
});
