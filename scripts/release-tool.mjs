#!/usr/bin/env node
/**
 * Release authentication: keygen | sign | verify | fingerprint.
 *
 * Needs only Node (>= 20). No third-party code, no network, no credentials, no production keys.
 *
 *   node scripts/release-tool.mjs keygen  --out ~/obsidian-release-key.pem     # operator, offline machine, ONCE
 *   node scripts/release-tool.mjs sign    --key ~/obsidian-release-key.pem [--releases releases]
 *   node scripts/release-tool.mjs verify  --fingerprint <FPR> [--releases releases] [--repo .] [--tag v1.8.2]
 *
 * What is authenticated. `sign` writes RELEASE-SIGNATURE.json: an Ed25519 signature over a small statement that
 * names the version, the source commit, the SHA-256 of SHA256SUMS and the SHA-256 of MANIFEST.json. SHA256SUMS
 * names every archive, and MANIFEST.json names every other artifact (SBOMs), so one signature covers everything.
 *
 * What `verify` decides. Three different questions, never merged:
 *   1. INTEGRITY  - every listed file exists, matches its digest, nothing unlisted is present.
 *   2. SIGNATURE  - the statement is signed by the key embedded beside it, and describes exactly these files.
 *   3. TRUST      - that key's fingerprint is one the CALLER pinned (--fingerprint or OBSIDIAN_RELEASE_FINGERPRINTS).
 * A signature by an unpinned key proves nothing about who published: the attacker who replaced the archives can
 * replace the key too. The fingerprint must come from a channel the attacker cannot edit (docs/release-signing.md).
 *
 * Exit codes: 0 authenticated (or --integrity-only and intact) | 1 failed a check (tampered, missing, wrong
 * version...) | 2 usage | 3 signed but the key is not pinned | 4 not signed (integrity only).
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SIGNATURE_FILE = 'RELEASE-SIGNATURE.json';
export const SIGNATURE_FORMAT = 'obsidian-release-signature-1';
const HERE = dirname(fileURLToPath(import.meta.url));

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** SHA-256 of the DER public key, as 8 groups of 8 hex characters. Short enough to read aloud, long enough to pin. */
export function fingerprintOfPublicKey(publicKeyDerBase64) {
  const hex = sha256(Buffer.from(publicKeyDerBase64, 'base64'));
  return hex.match(/.{8}/g).join(' ').toUpperCase();
}
const normalizeFingerprint = (value) => String(value).replace(/[^0-9a-f]/gi, '').toUpperCase();

export function generateReleaseKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey: der, fingerprint: fingerprintOfPublicKey(der) };
}

function parseSums(text) {
  const entries = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const match = /^([0-9a-f]{64})  ([^/\\\s][^/\\]*)$/.exec(line);
    if (!match) throw new Error(`SHA256SUMS has a line that is not "<sha256>  <file>": ${JSON.stringify(line.slice(0, 80))}`);
    if (entries.has(match[2])) throw new Error(`SHA256SUMS lists ${match[2]} twice`);
    entries.set(match[2], match[1]);
  }
  return entries;
}

export function signRelease({ releasesDir, privatePem }) {
  const sumsPath = join(releasesDir, 'SHA256SUMS');
  const manifestPath = join(releasesDir, 'MANIFEST.json');
  if (!existsSync(sumsPath) || !existsSync(manifestPath)) throw new Error('SHA256SUMS and MANIFEST.json must exist: run scripts/package-releases.sh first');
  // Never sign a digest list that does not describe the files beside it.
  const report = verifyRelease({ releasesDir, integrityOnly: true });
  if (!report.ok) throw new Error(`refusing to sign: ${report.failures.join('; ')}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const key = createPrivateKey(privatePem);
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
  const statement = JSON.stringify({
    format: SIGNATURE_FORMAT,
    product: manifest.product,
    version: manifest.version,
    commit: manifest.commit,
    protocolVersion: manifest.protocolVersion,
    sha256sums: sha256(readFileSync(sumsPath)),
    manifest: sha256(readFileSync(manifestPath)),
  });
  const signature = edSign(null, Buffer.from(statement, 'utf8'), key).toString('base64');
  const document = { format: SIGNATURE_FORMAT, statement, publicKey, fingerprint: fingerprintOfPublicKey(publicKey), signature };
  writeFileSync(join(releasesDir, SIGNATURE_FILE), `${JSON.stringify(document, null, 2)}\n`);
  return document;
}

function tarMember(archive, member) {
  try {
    return execFileSync('tar', ['-xOzf', archive, member], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

/**
 * @returns {{ ok: boolean, status: string, failures: string[], notes: string[], fingerprint?: string }}
 * status: AUTHENTICATED | INTEGRITY_OK_UNSIGNED | SIGNED_UNTRUSTED | FAILED
 */
export function verifyRelease({ releasesDir, fingerprints = [], integrityOnly = false, repo, tag, requireSbom = false }) {
  const failures = [];
  const notes = [];
  const fail = (message) => failures.push(message);
  const sumsPath = join(releasesDir, 'SHA256SUMS');
  const manifestPath = join(releasesDir, 'MANIFEST.json');
  if (!existsSync(sumsPath)) return { ok: false, status: 'FAILED', failures: ['SHA256SUMS is missing'], notes };
  if (!existsSync(manifestPath)) return { ok: false, status: 'FAILED', failures: ['MANIFEST.json is missing'], notes };

  // 1. integrity -------------------------------------------------------------------------------------------------
  let sums;
  try {
    sums = parseSums(readFileSync(sumsPath, 'utf8'));
  } catch (error) {
    return { ok: false, status: 'FAILED', failures: [error.message], notes };
  }
  for (const [name, digest] of sums) {
    const path = join(releasesDir, name);
    if (!existsSync(path)) fail(`${name} is listed in SHA256SUMS but missing`);
    else if (sha256(readFileSync(path)) !== digest) fail(`${name} does not match its SHA-256 (altered or corrupted)`);
  }
  const present = readdirSync(releasesDir).filter((name) => /\.(zip|tar\.gz)$/.test(name));
  for (const name of present) if (!sums.has(name)) fail(`${name} is present but not listed in SHA256SUMS (unlisted artifact)`);

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return { ok: false, status: 'FAILED', failures: [...failures, 'MANIFEST.json is not valid JSON'], notes };
  }
  for (const asset of manifest.assets ?? []) if (!sums.has(asset.name)) fail(`MANIFEST.json names ${asset.name}, which SHA256SUMS does not list`);
  for (const name of sums.keys()) if (!(manifest.assets ?? []).some((asset) => asset.name === name)) fail(`${name} is in SHA256SUMS but not in MANIFEST.json`);
  const artifacts = manifest.artifacts ?? [];
  for (const artifact of artifacts) {
    const path = join(releasesDir, artifact.name);
    if (!existsSync(path)) fail(`artifact ${artifact.name} is missing`);
    else if (sha256(readFileSync(path)) !== artifact.sha256) fail(`artifact ${artifact.name} does not match the digest in MANIFEST.json`);
  }
  if (requireSbom && !artifacts.some((artifact) => /sbom/.test(artifact.name))) fail('no SBOM is listed in MANIFEST.json');

  // 2. version / source agreement ----------------------------------------------------------------------------------
  const version = manifest.version;
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) fail(`MANIFEST.json version ${JSON.stringify(version)} is not x.y.z`);
  for (const name of sums.keys()) {
    const match = /^obsidian-[a-z-]+-(\d+\.\d+\.\d+)\.(zip|tar\.gz)$/.exec(name);
    if (!match) fail(`${name} does not look like an Obsidian release archive`);
    else if (match[1] !== version) fail(`${name} carries version ${match[1]} but the manifest says ${version} (stale archive)`);
  }
  if (!existsSync(join(releasesDir, `RELEASE-NOTES-${version}.md`))) fail(`RELEASE-NOTES-${version}.md is missing`);
  const coreArchive = join(releasesDir, `obsidian-core-${version}.tar.gz`);
  if (existsSync(coreArchive)) {
    const pkg = tarMember(coreArchive, './obsidian-core/package.json') ?? tarMember(coreArchive, 'obsidian-core/package.json') ?? tarMember(coreArchive, './package.json');
    const embedded = tarMember(coreArchive, './dist/version.js') ?? tarMember(coreArchive, 'dist/version.js') ?? tarMember(coreArchive, './obsidian-core/dist/version.js');
    if (!pkg) fail('the core archive has no package.json');
    else if (JSON.parse(pkg.toString()).version !== version) fail(`the core archive's package.json is ${JSON.parse(pkg.toString()).version}, not ${version}`);
    if (!embedded) fail('the core archive has no dist/version.js (stale or missing build)');
    else {
      const text = embedded.toString();
      const core = /CORE_VERSION\s*=\s*'([^']+)'/.exec(text)?.[1];
      const protocol = /PROTOCOL_VERSION\s*=\s*'([^']+)'/.exec(text)?.[1];
      if (core !== version) fail(`the built node in the core archive reports ${core}, not ${version} (stale generated code)`);
      if (protocol !== manifest.protocolVersion) fail(`the built node reports protocol ${protocol}, the manifest says ${manifest.protocolVersion}`);
    }
  } else fail(`obsidian-core-${version}.tar.gz is missing`);
  if (tag && tag !== `v${version}`) fail(`the release tag ${tag} does not match version ${version}`);
  if (repo) {
    try {
      const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      if (tag) {
        const tagged = git('rev-parse', `${tag}^{commit}`);
        // The archives are committed AFTER they are built, so the tag sits on a later commit that may only add releases/.
        const changed = git('diff', '--name-only', manifest.commit, tagged).split('\n').filter(Boolean);
        const outside = changed.filter((file) => !file.startsWith('releases/'));
        if (outside.length) fail(`the tag ${tag} differs from the built commit ${manifest.commit.slice(0, 12)} outside releases/: ${outside.slice(0, 3).join(', ')}`);
        else notes.push(`tag ${tag} = built commit ${manifest.commit.slice(0, 12)} plus releases/ only`);
      }
      const changelog = git('show', `${manifest.commit}:CHANGELOG.md`);
      const top = /^##\s+\[?(\d+\.\d+\.\d+)\]?/m.exec(changelog)?.[1];
      if (top !== version) fail(`CHANGELOG.md at the built commit is headed ${top}, not ${version}`);
    } catch (error) {
      fail(`could not check the source commit: ${String(error.stderr ?? error.message).trim().split('\n')[0]}`);
    }
  }

  if (failures.length) return { ok: false, status: 'FAILED', failures, notes };
  if (integrityOnly) return { ok: true, status: 'INTEGRITY_OK_UNSIGNED', failures, notes: [...notes, 'integrity only: no publisher was authenticated'] };

  // 3. signature ---------------------------------------------------------------------------------------------------
  const signaturePath = join(releasesDir, SIGNATURE_FILE);
  if (!existsSync(signaturePath)) return { ok: false, status: 'INTEGRITY_OK_UNSIGNED', failures: ['the release is not signed (no RELEASE-SIGNATURE.json): integrity is intact, authorship is unproven'], notes };
  let doc;
  let statement;
  try {
    doc = JSON.parse(readFileSync(signaturePath, 'utf8'));
    if (doc.format !== SIGNATURE_FORMAT) throw new Error('unsupported signature format');
    statement = JSON.parse(doc.statement);
    const publicKey = createPublicKey({ key: Buffer.from(doc.publicKey, 'base64'), format: 'der', type: 'spki' });
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('the signing key is not Ed25519');
    if (!edVerify(null, Buffer.from(doc.statement, 'utf8'), publicKey, Buffer.from(doc.signature, 'base64'))) throw new Error('the signature does not verify');
  } catch (error) {
    return { ok: false, status: 'FAILED', failures: [`invalid signature: ${error.message}`], notes };
  }
  if (statement.format !== SIGNATURE_FORMAT) fail('the signed statement has the wrong format');
  if (statement.sha256sums !== sha256(readFileSync(sumsPath))) fail('SHA256SUMS is not the file that was signed');
  if (statement.manifest !== sha256(readFileSync(manifestPath))) fail('MANIFEST.json is not the file that was signed');
  if (statement.version !== version || statement.commit !== manifest.commit) fail('the signed version/commit differ from the manifest');
  if (failures.length) return { ok: false, status: 'FAILED', failures, notes };

  const fingerprint = fingerprintOfPublicKey(doc.publicKey);
  if (normalizeFingerprint(doc.fingerprint) !== normalizeFingerprint(fingerprint)) return { ok: false, status: 'FAILED', failures: ['the fingerprint printed in the signature file is not the key\'s fingerprint'], notes };

  // 4. trust -------------------------------------------------------------------------------------------------------
  const pinned = fingerprints.map(normalizeFingerprint).filter(Boolean);
  if (!pinned.length) return { ok: false, status: 'SIGNED_UNTRUSTED', failures: ['the signature is valid but no publisher fingerprint was pinned (--fingerprint): authorship is NOT established'], notes, fingerprint };
  if (!pinned.includes(normalizeFingerprint(fingerprint))) return { ok: false, status: 'SIGNED_UNTRUSTED', failures: [`signed by ${fingerprint}, which is not a pinned publisher key`], notes, fingerprint };
  return { ok: true, status: 'AUTHENTICATED', failures: [], notes: [...notes, `signed by pinned publisher key ${fingerprint}`], fingerprint };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────────────────
function flags(argv) {
  const out = { _: [], fingerprint: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) out._.push(arg);
    else if (arg === '--integrity-only' || arg === '--require-sbom') out[arg.slice(2)] = true;
    else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      if (arg === '--fingerprint') out.fingerprint.push(value);
      else out[arg.slice(2)] = value;
    }
  }
  return out;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  let f;
  try {
    f = flags(rest);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const releasesDir = resolve(f.releases ?? join(HERE, '..', 'releases'));
  if (command === 'keygen') {
    if (!f.out) {
      console.error('keygen needs --out <file outside the repository>');
      process.exit(2);
    }
    if (existsSync(f.out)) {
      console.error(`${f.out} already exists: refusing to overwrite a key`);
      process.exit(1);
    }
    const key = generateReleaseKey();
    writeFileSync(f.out, key.privatePem, { mode: 0o600 });
    chmodSync(f.out, 0o600);
    console.log(`private key written to ${f.out} (mode 0600). Keep it offline; never commit it.`);
    console.log(`public key  : ${key.publicKey}`);
    console.log(`fingerprint : ${key.fingerprint}`);
    console.log('Publish the fingerprint through a channel an attacker of this repository cannot edit (docs/release-signing.md).');
    return;
  }
  if (command === 'sign') {
    if (!f.key) {
      console.error('sign needs --key <private key file>');
      process.exit(2);
    }
    try {
      const doc = signRelease({ releasesDir, privatePem: readFileSync(f.key, 'utf8') });
      console.log(`signed ${releasesDir} with key ${doc.fingerprint}`);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
    return;
  }
  if (command === 'fingerprint') {
    const doc = JSON.parse(readFileSync(join(releasesDir, SIGNATURE_FILE), 'utf8'));
    console.log(fingerprintOfPublicKey(doc.publicKey));
    return;
  }
  if (command === 'verify') {
    const fingerprints = [...f.fingerprint, ...(process.env.OBSIDIAN_RELEASE_FINGERPRINTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)];
    const report = verifyRelease({ releasesDir, fingerprints, integrityOnly: Boolean(f['integrity-only']), repo: f.repo, tag: f.tag, requireSbom: Boolean(f['require-sbom']) });
    for (const note of report.notes) console.log(`  ${note}`);
    for (const failure of report.failures) console.error(`  FAIL: ${failure}`);
    console.log(`${report.ok ? 'OK' : 'NOT VERIFIED'}: ${report.status}`);
    process.exit(report.ok ? 0 : report.status === 'SIGNED_UNTRUSTED' ? 3 : report.status === 'INTEGRITY_OK_UNSIGNED' ? 4 : 1);
  }
  console.error('usage: release-tool.mjs keygen --out F | sign --key F | verify --fingerprint FPR [--releases D] [--repo R --tag vX] [--integrity-only] [--require-sbom] | fingerprint');
  process.exit(2);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
