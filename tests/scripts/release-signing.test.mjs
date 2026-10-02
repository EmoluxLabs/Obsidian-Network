/**
 * Release signing behaviour.
 *
 *   node --test tests/scripts/release-signing.test.mjs
 *
 * A verification script that stays quiet about what it did not check is worse
 * than no script: it converts "unknown" into "verified" in the reader's head.
 * These tests drive the real shell scripts.
 *
 * Two environments have to be exercised, and they must not be left to chance:
 *
 *   - a machine with gpgv but no gnupg, which is the minimal install the
 *     scripts explicitly support, and
 *   - a machine with gnupg, where `verify-release.sh` prefers `gpg` and needs
 *     the publisher's key in the keyring to say anything useful.
 *
 * This distinction is not academic. These tests used to depend on whichever
 * tools happened to be installed: the fixture test asserted the gpgv path and
 * ran wherever gpg was absent, so it passed in the sandbox the code was written
 * in and failed on every CI runner, where gpg IS installed. The release job was
 * red on every run the repository had ever had, for that reason alone. The
 * gpgv-path tests therefore run with a PATH that cannot see gpg, and the gpg
 * path has its own test that imports the fixture key and verifies for real.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, copyFileSync, readdirSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const verify = join(repo, 'scripts', 'verify-release.sh');
const sign = join(repo, 'scripts', 'sign-release.sh');
const releases = join(repo, 'releases');
const fixtures = join(here, 'fixtures');

/** bash itself must be found even when the child's PATH is the trimmed farm. */
const BASH = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'].find((p) => existsSync(p)) ?? 'bash';

function run(cmd, args, cwd, env) {
  try {
    return {
      ok: true,
      out: execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: env ?? process.env }),
    };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

/**
 * A directory of symlinks to every tool on PATH except gpg. Putting it first on
 * PATH makes `command -v gpg` fail inside the scripts, so the gpgv path is
 * exercised identically on a laptop, in CI, and on a machine with gnupg
 * installed — including the "gnupg is not installed" refusal, which used to be
 * asserted only when it was already true.
 */
let farm;
function pathWithoutGpg() {
  if (farm) return farm;
  const dir = mkdtempSync(join(tmpdir(), 'obsidian-bin-'));
  for (const entry of (process.env.PATH ?? '').split(':')) {
    if (!entry) continue;
    let names;
    try {
      names = readdirSync(entry);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name === 'gpg') continue;
      const link = join(dir, name);
      if (existsSync(link)) continue;
      try {
        symlinkSync(join(entry, name), link);
      } catch {
        // A name that cannot be linked is simply not available in the farm.
      }
    }
  }
  farm = dir;
  return dir;
}

/** The environment the gpgv-only tests run in. */
function gpgvOnlyEnv() {
  return { ...process.env, PATH: pathWithoutGpg(), GNUPGHOME: join(pathWithoutGpg(), 'no-keyring') };
}

const archive = existsSync(releases)
  ? readdirSync(releases).find((f) => f.startsWith('obsidian-node-operator-') && f.endsWith('.tar.gz'))
  : undefined;

test('both scripts are valid shell', () => {
  for (const script of [verify, sign]) {
    const result = run(BASH, ['-n', script], repo);
    assert.equal(result.ok, true, `${script}: ${result.out}`);
  }
});

test('an unsigned release is called unsigned, not verified', { skip: !archive }, () => {
  const result = run(BASH, [verify, archive], releases, gpgvOnlyEnv());
  assert.equal(result.ok, true, result.out);
  assert.match(result.out, /UNSIGNED RELEASE/);
  assert.match(result.out, /not who built it/);
  // It still does the job it can do.
  assert.match(result.out, /OK: /);
});

test('a signature that could not be checked is never reported as passed', { skip: !archive }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'obsidian-sig-'));
  try {
    copyFileSync(join(releases, archive), join(scratch, archive));
    copyFileSync(join(releases, 'SHA256SUMS'), join(scratch, 'SHA256SUMS'));
    writeFileSync(join(scratch, 'SHA256SUMS.asc'), '-----BEGIN PGP SIGNATURE-----\nnope\n-----END PGP SIGNATURE-----\n');

    const result = run(BASH, [verify, archive], scratch, gpgvOnlyEnv());
    const checked = /signature OK/.test(result.out);
    const admitted = /was not checked|SIGNATURE DID NOT VERIFY|cannot dearmor/.test(result.out);
    assert.equal(checked, false, `claimed a signature was OK without gpg:\n${result.out}`);
    assert.equal(admitted, true, `said nothing about the unchecked signature:\n${result.out}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('signing refuses when gpg is missing instead of pretending', () => {
  const result = run(BASH, [sign], repo, gpgvOnlyEnv());
  assert.equal(result.ok, false, 'should exit non-zero without gpg');
  assert.match(result.out, /gpg is not installed/);
  assert.match(result.out, /pkg install gnupg/);
});

test('signing refuses to sign digests that do not match the archives', { skip: !archive }, () => {
  // Guards the worst failure mode: an authentic signature over a stale digest
  // list. The check must come before any call to gpg, so this reads the order
  // rather than depending on which tools are installed.
  const source = readdirSync(join(repo, 'scripts')).includes('sign-release.sh');
  assert.equal(source, true);
  const text = execFileSync('cat', [sign], { encoding: 'utf8' });
  const recheck = text.indexOf('sha256sum -c SHA256SUMS');
  const signing = text.indexOf('gpg "${SIGN_ARGS[@]}"');
  assert.ok(recheck > 0, 'no digest re-check before signing');
  assert.ok(signing > recheck, 'signing happens before the digest re-check');
  assert.match(text, /refusing to sign/);
});

test('a genuine signature verifies, with gpgv alone', { skip: !existsSync(join(fixtures, 'SHA256SUMS.asc')) }, () => {
  const scratch = mkdtempSync(join(tmpdir(), 'obsidian-goodsig-'));
  try {
    for (const file of ['SHA256SUMS', 'SHA256SUMS.asc', 'SIGNING-KEY.asc']) {
      copyFileSync(join(fixtures, file), join(scratch, file));
    }
    writeFileSync(join(scratch, 'fixture-archive.tar.gz'), 'not a real archive');
    copyFileSync(join(repo, 'scripts', 'dearmor.mjs'), join(scratch, 'dearmor.mjs'));
    copyFileSync(verify, join(scratch, 'verify-release.sh'));

    const result = run(BASH, [join(scratch, 'verify-release.sh'), 'fixture-archive.tar.gz', '--signature-only'], scratch, gpgvOnlyEnv());
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

    const result = run(BASH, [join(scratch, 'verify-release.sh'), 'fixture-archive.tar.gz', '--signature-only'], scratch, gpgvOnlyEnv());
    assert.equal(result.ok, false, `a bad signature must fail the script:\n${result.out}`);
    assert.match(result.out, /BAD signature|SIGNATURE DID NOT VERIFY/);
    assert.doesNotMatch(result.out, /signature OK/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

/**
 * The other half of the matrix: a real gnupg with the publisher's key in its
 * keyring. Skipped only when the key cannot be imported, which is an
 * environment fact and not a property of the scripts under test; on any machine
 * with gnupg installed, the happy path is exercised for real.
 */
function gpgWithFixtureKey() {
  const gpg = ['/usr/bin/gpg', '/usr/local/bin/gpg'].find((p) => existsSync(p));
  if (!gpg) return undefined;
  const home = mkdtempSync(join(tmpdir(), 'obsidian-gpg-'));
  const imported = run(gpg, ['--homedir', home, '--batch', '--no-tty', '--import', join(fixtures, 'SIGNING-KEY.asc')], repo);
  if (!imported.ok) {
    rmSync(home, { recursive: true, force: true });
    return undefined;
  }
  const listed = run(gpg, ['--homedir', home, '--batch', '--with-colons', '--list-keys'], repo);
  if (!listed.ok || !/^pub:/m.test(listed.out)) {
    rmSync(home, { recursive: true, force: true });
    return undefined;
  }
  return { gpg, home };
}

test('a genuine signature verifies with gnupg too, against the shipped key', { skip: !existsSync(join(fixtures, 'SHA256SUMS.asc')) }, () => {
  const real = gpgWithFixtureKey();
  if (!real) {
    // No usable gnupg here; the gpgv path above already covers verification.
    return;
  }
  const scratch = mkdtempSync(join(tmpdir(), 'obsidian-realgpg-'));
  try {
    for (const file of ['SHA256SUMS', 'SHA256SUMS.asc', 'SIGNING-KEY.asc']) {
      copyFileSync(join(fixtures, file), join(scratch, file));
    }
    writeFileSync(join(scratch, 'fixture-archive.tar.gz'), 'not a real archive');
    copyFileSync(join(repo, 'scripts', 'dearmor.mjs'), join(scratch, 'dearmor.mjs'));
    copyFileSync(verify, join(scratch, 'verify-release.sh'));

    const env = { ...process.env, GNUPGHOME: real.home };
    const good = run(BASH, [join(scratch, 'verify-release.sh'), 'fixture-archive.tar.gz', '--signature-only'], scratch, env);
    assert.equal(good.ok, true, `gnupg could not verify the shipped signature:\n${good.out}`);
    assert.match(good.out, /verifying the signature over SHA256SUMS/);
    assert.match(good.out, /signature OK/);

    // And the same gnupg must reject the tampered list, not merely be bypassed.
    writeFileSync(join(scratch, 'SHA256SUMS'), 'deadbeef  evil-archive.tar.gz\n');
    const bad = run(BASH, [join(scratch, 'verify-release.sh'), 'fixture-archive.tar.gz', '--signature-only'], scratch, env);
    assert.equal(bad.ok, false, `a bad signature must fail the script:\n${bad.out}`);
    assert.match(bad.out, /SIGNATURE DID NOT VERIFY/);
    assert.doesNotMatch(bad.out, /signature OK/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(real.home, { recursive: true, force: true });
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
