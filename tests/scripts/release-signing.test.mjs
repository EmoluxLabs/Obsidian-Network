/**
 * Release signing behaviour.
 *
 *   node --test tests/scripts/release-signing.test.mjs
 *
 * A verification script that stays quiet about what it did not check is worse
 * than no script: it converts "unknown" into "verified" in the reader's head.
 * These tests drive the real shell scripts.
 *
 * Note on coverage: this sandbox has gpgv but not gpg, so the happy path —
 * a genuine signature verifying against a real key — is NOT exercised here.
 * What is exercised is every path where the answer is "no" or "unknown", which
 * is where silence would be dangerous.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, copyFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const verify = join(repo, 'scripts', 'verify-release.sh');
const sign = join(repo, 'scripts', 'sign-release.sh');
const releases = join(repo, 'releases');

function run(cmd, args, cwd) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

const archive = existsSync(releases)
  ? readdirSync(releases).find((f) => f.startsWith('obsidian-node-operator-') && f.endsWith('.tar.gz'))
  : undefined;

test('both scripts are valid shell', () => {
  for (const script of [verify, sign]) {
    const result = run('bash', ['-n', script], repo);
    assert.equal(result.ok, true, `${script}: ${result.out}`);
  }
});

test('an unsigned release is called unsigned, not verified', { skip: !archive }, () => {
  const result = run('bash', [verify, archive], releases);
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /UNSIGNED RELEASE/);
  assert.match(result.out, /not who built it/);
  // It still does the job it can do.
  assert.match(result.out, /OK: /);
});

test('a signature that could not be checked is never reported as passed', { skip: !archive }, () => {
  // gpg is absent in this environment, which is exactly the case where a
  // careless script would print nothing and let the reader assume success.
  const scratch = mkdtempSync(join(tmpdir(), 'obsidian-sig-'));
  try {
    copyFileSync(join(releases, archive), join(scratch, archive));
    copyFileSync(join(releases, 'SHA256SUMS'), join(scratch, 'SHA256SUMS'));
    writeFileSync(join(scratch, 'SHA256SUMS.asc'), '-----BEGIN PGP SIGNATURE-----\nnope\n-----END PGP SIGNATURE-----\n');

    const result = run('bash', [verify, archive], scratch);
    const checked = /signature OK/.test(result.out);
    const admitted = /was not checked|SIGNATURE DID NOT VERIFY|cannot dearmor/.test(result.out);
    assert.equal(checked, false, `claimed a signature was OK without gpg:\n${result.out}`);
    assert.equal(admitted, true, `said nothing about the unchecked signature:\n${result.out}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('signing refuses when gpg is missing instead of pretending', () => {
  const result = run('bash', [sign], repo);
  if (!process.env.PATH.split(':').some((dir) => existsSync(join(dir, 'gpg')))) {
    assert.equal(result.ok, false, 'should exit non-zero without gpg');
    assert.match(result.out, /gpg is not installed/);
    assert.match(result.out, /pkg install gnupg/);
  }
});

test('signing refuses to sign digests that do not match the archives', { skip: !archive }, () => {
  // Guards the worst failure mode: an authentic signature over a stale digest
  // list. The check must come before any call to gpg, so it is observable
  // even here where gpg is absent — by reading the script's order.
  const source = readdirSync(join(repo, 'scripts')).includes('sign-release.sh');
  assert.equal(source, true);
  const text = execFileSync('cat', [sign], { encoding: 'utf8' });
  const recheck = text.indexOf('sha256sum -c SHA256SUMS');
  const signing = text.indexOf('gpg "${SIGN_ARGS[@]}"');
  assert.ok(recheck > 0, 'no digest re-check before signing');
  assert.ok(signing > recheck, 'signing happens before the digest re-check');
  assert.match(text, /refusing to sign/);
});

const fixtures = join(here, 'fixtures');

test('a genuine signature verifies, with gpgv alone', { skip: !existsSync(join(fixtures, 'SHA256SUMS.asc')) }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'obsidian-goodsig-'));
  try {
    for (const file of ['SHA256SUMS', 'SHA256SUMS.asc', 'SIGNING-KEY.asc']) {
      copyFileSync(join(fixtures, file), join(scratch, file));
    }
    writeFileSync(join(scratch, 'fixture-archive.tar.gz'), 'not a real archive');
    copyFileSync(join(repo, 'scripts', 'dearmor.mjs'), join(scratch, 'dearmor.mjs'));
    copyFileSync(verify, join(scratch, 'verify-release.sh'));

    const result = run('bash', [join(scratch, 'verify-release.sh'), 'fixture-archive.tar.gz', '--signature-only'], scratch);
    assert.equal(result.ok, true, result.out);
    // gpgv's own "Good signature" line goes to stderr; what this asserts is
    // the script's contract: it reports OK only after gpgv exited zero.
    assert.match(result.out, /signature OK/);
    assert.match(result.out, /verifying with gpgv/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a tampered digest list fails the signature and stops the script', { skip: !existsSync(join(fixtures, 'SHA256SUMS.asc')) }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'obsidian-badsig-'));
  try {
    for (const file of ['SHA256SUMS', 'SHA256SUMS.asc', 'SIGNING-KEY.asc']) {
      copyFileSync(join(fixtures, file), join(scratch, file));
    }
    // Exactly the attack the signature exists to stop: the archive and its
    // digest both replaced, consistently.
    writeFileSync(join(scratch, 'SHA256SUMS'), 'deadbeef  evil-archive.tar.gz\n');
    writeFileSync(join(scratch, 'fixture-archive.tar.gz'), 'not a real archive');
    copyFileSync(join(repo, 'scripts', 'dearmor.mjs'), join(scratch, 'dearmor.mjs'));
    copyFileSync(verify, join(scratch, 'verify-release.sh'));

    const result = run('bash', [join(scratch, 'verify-release.sh'), 'fixture-archive.tar.gz', '--signature-only'], scratch);
    assert.equal(result.ok, false, `a bad signature must fail the script:\n${result.out}`);
    assert.match(result.out, /BAD signature|SIGNATURE DID NOT VERIFY/);
    assert.doesNotMatch(result.out, /signature OK/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('dearmor rejects something that is not a public key', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'obsidian-dearmor-'));
  try {
    const bogus = join(scratch, 'key.asc');
    writeFileSync(bogus, 'hello, not a key');
    const result = run(process.execPath, [join(repo, 'scripts', 'dearmor.mjs'), bogus, join(scratch, 'out')], scratch);
    assert.equal(result.ok, false);
    assert.match(result.out, /not an armoured PGP public key/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
