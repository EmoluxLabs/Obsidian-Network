import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('the supplied design is kept byte for byte', () => {
  const recorded = readFileSync(join(root, 'template', 'TEMPLATE.sha256'), 'utf8').split(/\s+/)[0];
  const actual = createHash('sha256').update(readFileSync(join(root, 'template', 'obsidian-wallet.html'))).digest('hex');
  assert.equal(actual, recorded);
});

const shipped = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (path === join(root, 'public', 'js')) continue; // the web app's own generated code
      walk(path);
    } else if (/\.(mjs|html|css)$/.test(name)) shipped.push(path);
  }
})(join(root, 'public'));

test('nothing the design invented as a placeholder ships', () => {
  assert.ok(shipped.length >= 6);
  const banned = [
    [/P-256|ECDSA|namedCurve/, 'the demo signature scheme'],
    [/obs1\[0-9a-f\]\{38\}/, 'the demo address format'],
    [/\bFEE\s*=\s*0\.001\b/, 'the demo fee'],
    [/QRLIB|BarcodeDetector/, 'the demo QR code path'],
    [/\bobsw\b|\bobsd\b/, 'the demo storage keys'],
    [/placeholder\)\.|Replace WL/, 'the demo word list note'],
    [/data-a="(copyPk|copyRk|dlRk|showPk)"|COPY PRIVATE KEY|EXPORT PRIVATE KEY/, 'the design\u2019s private-key copy/export controls'],
  ];
  for (const file of shipped) {
    const text = readFileSync(file, 'utf8');
    for (const [pattern, what] of banned) {
      if (!what) continue;
      assert.ok(!pattern.test(text), `${file} contains ${what}`);
    }
    // Since 1.9.0 a private key can be SHOWN at creation/backup and IMPORTED after local validation. It is never copied,
    // downloaded, sent, logged or stored in the clear: no clipboard, network, console or storage call may share a line with a key.
    for (const line of text.split('\n')) {
      if (/private ?key|pendingKey/i.test(line)) {
        assert.ok(!/clipboard|fetch\(|sendBeacon|XMLHttpRequest|console\.|localStorage|sessionStorage/.test(line), `${file}: a private-key line must not copy, send, log or store: "${line.trim().slice(0, 80)}"`);
      }
    }
  }
});
