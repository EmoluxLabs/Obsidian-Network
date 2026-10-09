import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('Manifest V3 with the version of the package', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, pkg.version);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test('least privilege: exactly storage, alarms and notifications; no host access until the user grants one', () => {
  assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'notifications', 'storage']);
  assert.equal(manifest.host_permissions, undefined, 'no install-time host permissions');
  for (const pattern of manifest.optional_host_permissions) assert.ok(/^(https:\/\/\*\/\*|http:\/\/(localhost|127\.0\.0\.1)\/\*)$/.test(pattern), pattern);
  for (const forbidden of ['tabs', 'activeTab', 'cookies', 'webRequest', 'webRequestBlocking', 'declarativeNetRequest', 'scripting', 'history', 'bookmarks', 'clipboardRead', 'management', 'nativeMessaging', 'unlimitedStorage', 'downloads', 'debugger', '<all_urls>']) {
    assert.ok(!manifest.permissions.includes(forbidden), forbidden);
    assert.ok(!(manifest.optional_permissions ?? []).includes(forbidden), forbidden);
  }
});

test('no way for a web page to reach the extension or run code in a page', () => {
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.equal(manifest.devtools_page, undefined);
  assert.equal(manifest.sandbox, undefined);
  assert.equal(manifest.chrome_url_overrides, undefined);
});

test('CSP: own scripts only, no eval, no inline script, no remote code, no plugins', () => {
  const csp = manifest.content_security_policy.extension_pages;
  assert.ok(typeof manifest.content_security_policy === 'object');
  const directives = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([name, ...values]) => [name, values]));
  assert.deepEqual(directives['script-src'], ["'self'"]);
  assert.deepEqual(directives['object-src'], ["'self'"]);
  assert.deepEqual(directives['base-uri'], ["'none'"]);
  assert.ok(!/unsafe-eval|unsafe-inline.*script|wasm-unsafe-eval|http:\/\/(?!127\.0\.0\.1|localhost)/.test(csp.replace(/style-src[^;]*;?/, '')));
  assert.ok(!directives['script-src'].some((v) => /^(https?:|\*|data:|blob:)/.test(v)));
  // connect-src is https plus loopback http, mirroring the address rules in config.mjs
  for (const v of directives['connect-src']) assert.ok(["'self'", 'https:', 'http://127.0.0.1:*', 'http://localhost:*'].includes(v), v);
});

test('entry points exist in src/ and the icon set is the template\u2019s', () => {
  const sources = fs.readdirSync(path.join(root, 'src'));
  assert.ok(sources.includes(manifest.options_ui.page));
  assert.ok(sources.includes(manifest.action.default_popup.split('?')[0]));
  assert.ok(sources.includes(manifest.background.service_worker));
  assert.deepEqual(manifest.background.scripts, [manifest.background.service_worker]);
  assert.equal(manifest.background.type, 'module');
  assert.deepEqual(Object.keys(manifest.icons), ['16', '32', '48', '128']);
});

test('a real Firefox id, not the template\u2019s placeholder', () => {
  const id = manifest.browser_specific_settings.gecko.id;
  assert.ok(!/example\.invalid/.test(id));
  assert.match(id, /^[a-z0-9._-]+@[a-z0-9.-]+$/);
});

test('the template zip is untouched', async () => {
  const { createHash } = await import('node:crypto');
  const zip = fs.readFileSync(path.join(root, 'template', 'obsidian-extension.zip'));
  assert.equal(createHash('sha256').update(zip).digest('hex'), 'afc42994f9c363ed5516cd6924248cc841aa08afcc267ec0dd639b04f3d9204c');
});
