import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scanText } from '../../scripts/scan-secrets.mjs';

// Built from pieces so this file does not itself contain a token-shaped string.
const ghp = 'gh' + 'p_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const aws = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP';
const armour = '-----BEGIN ' + 'PRIVATE KEY-----';

test('finds well-known token shapes and private-key armour, by rule and line only', () => {
  const found = scanText(['ok', `token = "${ghp}"`, `k: ${aws}`, armour].join('\n'));
  assert.deepEqual(found.map((f) => [f.line, f.rule]).sort(), [[2, 'github-token'], [3, 'aws-access-key-id'], [4, 'private-key-armour']].sort());
  for (const f of found) assert.deepEqual(Object.keys(f).sort(), ['line', 'rule']); // never the matched text
});

test('finds a literal bound to a secret-sounding name, and ignores placeholders and short values', () => {
  assert.equal(scanText('const passphrase = "Zq7vK2mP9xL4nR8tW3yB6cD1"').length, 1); // scan-secrets:allow synthetic fixture
  assert.equal(scanText('"apiKey": "Zq7vK2mP9xL4nR8tW3yB6cD1"').length, 1); // scan-secrets:allow synthetic fixture
  assert.equal(scanText('password = "xxxxxxxxxxxxxxxxxxxxxxxxxxxx"').length, 0);
  assert.equal(scanText('passphrase = "short"').length, 0);
  assert.equal(scanText('const x = readSecret()').length, 0);
  assert.equal(scanText('password = "Zq7vK2mP9xL4nR8tW3yB6cD1" // scan-secrets:allow reviewed fixture').length, 0);
});

test('the repository as committed is clean', () => {
  const run = spawnSync(process.execPath, [resolve(import.meta.dirname, '../../scripts/scan-secrets.mjs')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout);
  assert.match(run.stdout, /^OK: \d+ files scanned, 0 finding/m);
});
