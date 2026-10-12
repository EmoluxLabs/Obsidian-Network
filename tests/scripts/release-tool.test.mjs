/**
 * Release authentication (scripts/release-tool.mjs), driven end to end on a synthetic release directory whose layout
 * matches what scripts/package-releases.sh writes. Needs no gpg, no network and no production key: every key here is
 * generated for the test and thrown away.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateReleaseKey, signRelease, verifyRelease, fingerprintOfPublicKey } from '../../scripts/release-tool.mjs';

const TOOL = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'release-tool.mjs');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const dirs = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'obsidian-reltool-'));
  dirs.push(dir);
  return dir;
};
process.on('exit', () => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A release of `version` whose core archive embeds `built` as its node version. */
function makeRelease({ version = '9.9.9', built = version, protocol = '9.9.0', pkgVersion = version, extra = {} } = {}) {
  const dir = scratch();
  const releases = join(dir, 'releases');
  mkdirSync(releases);
  const stage = join(dir, 'stage', 'obsidian-core');
  mkdirSync(join(stage, 'dist'), { recursive: true });
  writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: '@obsidian/core', version: pkgVersion }));
  writeFileSync(join(stage, 'dist', 'version.js'), `export const CORE_VERSION = '${built}';\nexport const PROTOCOL_VERSION = '${protocol}';\n`);
  execFileSync('tar', ['-czf', join(releases, `obsidian-core-${version}.tar.gz`), '-C', dirname(stage), 'obsidian-core']);
  // the verifier looks for ./obsidian-core/... or ./dist/..., so also write the archive layout the packager uses
  execFileSync('tar', ['-czf', join(releases, `obsidian-core-${version}.tar.gz`), '-C', stage, '.']);
  writeFileSync(join(releases, `obsidian-core-${version}.zip`), 'not-really-a-zip-but-bytes');
  writeFileSync(join(releases, `RELEASE-NOTES-${version}.md`), '# notes\n');
  writeFileSync(join(releases, 'sbom-core.cdx.json'), '{"bomFormat":"CycloneDX"}');
  const names = [`obsidian-core-${version}.tar.gz`, `obsidian-core-${version}.zip`];
  writeFileSync(join(releases, 'SHA256SUMS'), names.map((n) => `${sha(readFileSync(join(releases, n)))}  ${n}`).join('\n') + '\n');
  writeFileSync(
    join(releases, 'MANIFEST.json'),
    JSON.stringify({
      product: 'Obsidian Network', version, commit: 'a'.repeat(40), protocolVersion: protocol,
      assets: names.map((name) => ({ name, bytes: statSync(join(releases, name)).size })),
      artifacts: [{ name: 'sbom-core.cdx.json', sha256: sha(readFileSync(join(releases, 'sbom-core.cdx.json'))) }],
      ...extra,
    }),
  );
  return releases;
}
const signed = (opts) => {
  const releases = makeRelease(opts);
  const key = generateReleaseKey();
  signRelease({ releasesDir: releases, privatePem: key.privatePem });
  return { releases, key };
};

test('a signed release verifies as AUTHENTICATED only when the caller pinned the publisher fingerprint', () => {
  const { releases, key } = signed();
  const ok = verifyRelease({ releasesDir: releases, fingerprints: [key.fingerprint] });
  assert.equal(ok.status, 'AUTHENTICATED', ok.failures.join('; '));
  assert.equal(ok.ok, true);
  // fingerprint formatting is irrelevant (spaces, case, colons)
  assert.equal(verifyRelease({ releasesDir: releases, fingerprints: [key.fingerprint.toLowerCase().replaceAll(' ', ':')] }).status, 'AUTHENTICATED');
});

test('a valid signature by an UNPINNED key is not authentication', () => {
  const { releases } = signed();
  const none = verifyRelease({ releasesDir: releases, fingerprints: [] });
  assert.equal(none.status, 'SIGNED_UNTRUSTED');
  assert.equal(none.ok, false);
  const other = verifyRelease({ releasesDir: releases, fingerprints: [generateReleaseKey().fingerprint] });
  assert.equal(other.status, 'SIGNED_UNTRUSTED');
  assert.match(other.failures[0], /not a pinned publisher key/);
});

test('an attacker who replaces the archives, the sums AND the key is caught by the pinned fingerprint', () => {
  const { releases, key } = signed();
  const attacker = generateReleaseKey();
  signRelease({ releasesDir: releases, privatePem: attacker.privatePem });
  const verdict = verifyRelease({ releasesDir: releases, fingerprints: [key.fingerprint] });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 'SIGNED_UNTRUSTED');
});

test('an unsigned release is integrity-only, never authenticated', () => {
  const releases = makeRelease();
  const verdict = verifyRelease({ releasesDir: releases, fingerprints: ['AA'] });
  assert.equal(verdict.status, 'INTEGRITY_OK_UNSIGNED');
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures[0], /not signed/);
  const opted = verifyRelease({ releasesDir: releases, integrityOnly: true });
  assert.equal(opted.ok, true);
  assert.match(opted.notes.join(' '), /no publisher was authenticated/);
});

test('altered, missing, unlisted and stale artifacts all fail', () => {
  const alter = signed();
  writeFileSync(join(alter.releases, 'obsidian-core-9.9.9.zip'), 'tampered');
  assert.match(verifyRelease({ releasesDir: alter.releases, fingerprints: [alter.key.fingerprint] }).failures.join(), /does not match its SHA-256/);

  const missing = signed();
  rmSync(join(missing.releases, 'obsidian-core-9.9.9.zip'));
  assert.match(verifyRelease({ releasesDir: missing.releases, fingerprints: [missing.key.fingerprint] }).failures.join(), /listed in SHA256SUMS but missing/);

  const extra = signed();
  writeFileSync(join(extra.releases, 'obsidian-interface-9.9.9.zip'), 'smuggled');
  assert.match(verifyRelease({ releasesDir: extra.releases, fingerprints: [extra.key.fingerprint] }).failures.join(), /not listed in SHA256SUMS/);

  const stale = signed();
  copyFileSync(join(stale.releases, 'obsidian-core-9.9.9.zip'), join(stale.releases, 'obsidian-core-9.9.8.zip'));
  assert.match(verifyRelease({ releasesDir: stale.releases, fingerprints: [stale.key.fingerprint] }).failures.join(), /9\.9\.8|not listed/);

  const sbom = signed();
  writeFileSync(join(sbom.releases, 'sbom-core.cdx.json'), '{"bomFormat":"forged"}');
  assert.match(verifyRelease({ releasesDir: sbom.releases, fingerprints: [sbom.key.fingerprint] }).failures.join(), /sbom-core.cdx.json does not match/);
});

test('a tampered manifest or sums file invalidates the signature even if every digest is recomputed', () => {
  const { releases, key } = signed();
  const manifest = JSON.parse(readFileSync(join(releases, 'MANIFEST.json'), 'utf8'));
  manifest.paramsHash = 'forged';
  writeFileSync(join(releases, 'MANIFEST.json'), JSON.stringify(manifest));
  const verdict = verifyRelease({ releasesDir: releases, fingerprints: [key.fingerprint] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures.join(), /MANIFEST.json is not the file that was signed/);
});

test('a corrupted or forged signature file fails closed', () => {
  const { releases, key } = signed();
  const path = join(releases, 'RELEASE-SIGNATURE.json');
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...doc, signature: Buffer.alloc(64, 1).toString('base64') }));
  assert.match(verifyRelease({ releasesDir: releases, fingerprints: [key.fingerprint] }).failures.join(), /invalid signature/);
  writeFileSync(path, '{not json');
  assert.equal(verifyRelease({ releasesDir: releases, fingerprints: [key.fingerprint] }).status, 'FAILED');
  writeFileSync(path, JSON.stringify({ ...doc, publicKey: generateReleaseKey().publicKey }));
  assert.equal(verifyRelease({ releasesDir: releases, fingerprints: [key.fingerprint] }).status, 'FAILED');
});

test('version agreement: stale generated code, wrong package version, wrong protocol and wrong tag are refused', () => {
  const built = makeRelease({ version: '9.9.9', built: '9.9.8' });
  assert.match(verifyRelease({ releasesDir: built, integrityOnly: true }).failures.join(), /stale generated code/);
  const pkg = makeRelease({ version: '9.9.9', pkgVersion: '9.9.8' });
  assert.match(verifyRelease({ releasesDir: pkg, integrityOnly: true }).failures.join(), /package.json is 9.9.8/);
  const protocol = makeRelease({ extra: { protocolVersion: '1.0.0' } });
  assert.match(verifyRelease({ releasesDir: protocol, integrityOnly: true }).failures.join(), /protocol 9.9.0, the manifest says 1.0.0/);
  const tag = makeRelease();
  assert.match(verifyRelease({ releasesDir: tag, integrityOnly: true, tag: 'v9.9.8' }).failures.join(), /does not match version/);
});

test('signing refuses a digest list that does not describe the files', () => {
  const releases = makeRelease();
  writeFileSync(join(releases, 'obsidian-core-9.9.9.zip'), 'changed after sums were written');
  assert.throws(() => signRelease({ releasesDir: releases, privatePem: generateReleaseKey().privatePem }), /refusing to sign/);
});

test('the source commit check: the tag may add only releases/ to the built commit', () => {
  const repo = scratch();
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(join(repo, 'CHANGELOG.md'), '# Changelog\n\n## [9.9.9] — now\n');
  git('add', '.'); git('commit', '-qm', 'built');
  const built = git('rev-parse', 'HEAD');
  mkdirSync(join(repo, 'releases'));
  writeFileSync(join(repo, 'releases', 'x'), 'archives');
  git('add', '.'); git('commit', '-qm', 'archives'); git('tag', 'v9.9.9');
  const releases = makeRelease({ extra: { commit: built } });
  const good = verifyRelease({ releasesDir: releases, integrityOnly: true, repo, tag: 'v9.9.9' });
  assert.equal(good.ok, true, good.failures.join('; '));
  // a source change smuggled into the tag commit is caught
  writeFileSync(join(repo, 'evil.js'), 'x');
  git('add', '.'); git('commit', '-qm', 'sneaky'); git('tag', '-f', 'v9.9.9');
  const bad = verifyRelease({ releasesDir: releases, integrityOnly: true, repo, tag: 'v9.9.9' });
  assert.match(bad.failures.join(), /outside releases\/: evil.js/);
});

test('CLI exit codes: 0 authenticated, 1 tampered, 3 untrusted key, 4 unsigned, 2 usage', () => {
  const run = (args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
  const { releases, key } = signed();
  assert.equal(run(['verify', '--releases', releases, '--fingerprint', key.fingerprint]).status, 0);
  assert.equal(run(['verify', '--releases', releases]).status, 3);
  assert.equal(run(['verify', '--releases', makeRelease()]).status, 4);
  writeFileSync(join(releases, 'obsidian-core-9.9.9.zip'), 'tampered');
  assert.equal(run(['verify', '--releases', releases, '--fingerprint', key.fingerprint]).status, 1);
  assert.equal(run(['nonsense']).status, 2);
  assert.equal(run(['keygen']).status, 2);
});

test('keygen writes a 0600 key, prints only the public half, and never overwrites', () => {
  const out = join(scratch(), 'k.pem');
  const first = spawnSync(process.execPath, [TOOL, 'keygen', '--out', out], { encoding: 'utf8' });
  assert.equal(first.status, 0);
  assert.equal(statSync(out).mode & 0o777, 0o600);
  const pem = readFileSync(out, 'utf8');
  assert.ok(!first.stdout.includes(pem.split('\n')[1]), 'the private key is never printed');
  assert.match(first.stdout, /fingerprint : ([0-9A-F]{8} ){7}[0-9A-F]{8}/);
  assert.equal(spawnSync(process.execPath, [TOOL, 'keygen', '--out', out], { encoding: 'utf8' }).status, 1);
  assert.equal(fingerprintOfPublicKey(generateReleaseKey().publicKey).split(' ').length, 8);
});
