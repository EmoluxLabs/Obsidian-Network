import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LogBuffer } from '../core/log-buffer.js';
import { redactText, redactValue } from '../core/redact.js';
import { RpcClient, RpcError, assertLoopback, parseHealth } from '../core/rpc-client.js';
import { SettingsStore, defaultSettings, validateNodeSettings, validateSettings } from '../core/settings.js';
import { createPaths } from '../core/paths.js';
import { tempDir } from './helpers.js';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('redact: recovery phrases, keyed secrets and the home path never survive', () => {
  const r1 = redactText(`oops: ${PHRASE}.`);
  assert.ok(r1.includes('[redacted recovery phrase]') && !r1.includes('abandon'), r1);
  assert.match(redactText(`privateKey: ${'ab'.repeat(32)}`), /privateKey: \[redacted\]/);
  assert.match(redactText('passphrase=hunter2hunter2 x'), /passphrase=\[redacted\] x/);
  assert.match(redactText('Authorization: Bearer abc.def.ghi'), /Authorization: \[redacted\]/);
  assert.equal(redactText('/home/alice/data/x', '/home/alice'), '~/data/x');
  const v = redactValue({ ok: 1, privateKey: 'x', nested: { mnemonic: 'y', fine: 'z' } }) as Record<string, any>;
  assert.equal(v.privateKey, '[redacted]');
  assert.equal(v.nested.mnemonic, '[redacted]');
  assert.equal(v.nested.fine, 'z');
});

test('log buffer: parses node JSON, redacts, bounds memory, filters and notifies', () => {
  const { dir, cleanup } = tempDir();
  try {
    const logs = new LogBuffer(5, join(dir, 'logs', 'node.log'));
    const seen: number[] = [];
    logs.onEntry((e) => seen.push(e.id));
    logs.line(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', component: 'p2p', message: 'peer slow', privateKey: 'ab'.repeat(32) }), 'stdout');
    logs.line('plain text line', 'stdout');
    logs.line(`crash ${PHRASE}`, 'stderr');
    for (let i = 0; i < 10; i += 1) logs.app('INFO', `n${i}`);
    assert.equal(logs.recent({ limit: 100 }).length, 5, 'ring buffer is bounded');
    assert.equal(seen.length, 13);
    const first = new LogBuffer(50);
    const e = first.line(JSON.stringify({ level: 'warn', component: 'p2p', message: 'm', privateKey: 'ab'.repeat(32) }), 'stdout')!;
    assert.equal(e.severity, 'WARN');
    assert.equal((e.fields as any).privateKey, '[redacted]');
    const err = first.line(`crash ${PHRASE}`, 'stderr')!;
    assert.equal(err.severity, 'ERROR');
    assert.ok(!err.message.includes('abandon'));
    assert.equal(first.recent({ minSeverity: 'ERROR' }).length, 1);
    const file = readFileSync(join(dir, 'logs', 'node.log'), 'utf8');
    assert.ok(!file.includes('abandon') && !file.includes('ab'.repeat(32)), 'the on-disk copy is redacted too');
  } finally {
    cleanup();
  }
});

test('settings: defaults validate, bad values are refused, changes report restart-required fields, corrupt files are kept', () => {
  assert.doesNotThrow(() => validateSettings(defaultSettings()));
  const base = defaultSettings().nodes.devnet;
  for (const bad of [{ nodeName: '' }, { nodeName: '../x' }, { portOffset: 101 }, { portOffset: -1 }, { portOffset: 1.5 }, { seeds: ['nonsense'] }, { seeds: ['h:99999'] }, { logLevel: 'trace' }, { blockProduction: 'yes' }]) {
    assert.throws(() => validateNodeSettings({ ...base, ...bad }), `${JSON.stringify(bad)} must be refused`);
  }
  const { dir, cleanup } = tempDir();
  try {
    const paths = createPaths(dir);
    const store = new SettingsStore(paths.settings);
    const r = store.update({ node: { network: 'devnet', values: { ...base, portOffset: 7, seeds: ['seed.example.org:8631'] } } });
    assert.deepEqual(r.changedNodeFields.sort(), ['portOffset', 'seeds']);
    assert.equal(new SettingsStore(paths.settings).get().nodes.devnet.portOffset, 7, 'persisted');
    assert.equal(store.update({ node: { network: 'devnet', values: store.get().nodes.devnet } }).changedNodeFields.length, 0);
    // a hand-damaged file is not deleted and not silently used
    writeFileSync(paths.settings, '{ not json');
    const again = new SettingsStore(paths.settings);
    assert.ok(again.recovered, 'recovery is reported');
    assert.ok(existsSync(again.recovered!.backup), 'the unreadable file is kept');
    assert.equal(again.get().nodes.devnet.portOffset, 0);
    assert.ok(readdirSync(dir).some((f) => f.includes('.invalid-')));
  } finally {
    cleanup();
  }
});

const goodHealth = { status: 'ok', coreVersion: '1.7.0', protocolVersion: '1.7.0', network: 'devnet', networkId: 'x', chainId: 7780, genesisId: 'g', paramsHash: 'p', height: 1, headHash: 'h', peers: 0, syncing: false, supplyOk: true, uptimeSeconds: 3, timestamp: 5 };

function fakeFetch(handler: (url: string) => { status?: number; body?: string; delay?: number; headers?: Record<string, string> } | Error): typeof fetch {
  return (async (input: any, init: any) => {
    const r = handler(String(input));
    if (r instanceof Error) throw r;
    if (r.delay) await new Promise((res, rej) => { const t = setTimeout(res, r.delay); init?.signal?.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }); });
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
}

test('rpc client: loopback only, validates shapes, classifies every failure', async () => {
  assert.throws(() => assertLoopback('http://example.com:8630'), RpcError);
  assert.throws(() => assertLoopback('https://127.0.0.1:8630'), RpcError);
  assert.doesNotThrow(() => assertLoopback('http://127.0.0.1:8630'));
  assert.throws(() => new RpcClient({ baseUrl: 'http://192.168.1.5:8630' }), RpcError);

  const ok = new RpcClient({ baseUrl: 'http://127.0.0.1:1', fetchImpl: fakeFetch(() => ({ body: JSON.stringify(goodHealth) })) });
  assert.equal((await ok.health()).height, 1);

  const kinds: Array<[string, any, string]> = [
    ['malformed json', { body: '<html>' }, 'malformed'],
    ['wrong shape', { body: JSON.stringify({ ...goodHealth, height: 'one' }) }, 'malformed'],
    ['missing field', { body: JSON.stringify({ status: 'ok' }) }, 'malformed'],
    ['server error', { status: 500, body: JSON.stringify({ error: 'boom', code: 'ERR_X' }) }, 'http'],
    ['too large', { body: '{}', headers: { 'content-length': String(99 * 1024 * 1024) } }, 'too-large'],
    ['unreachable', new Error('ECONNREFUSED'), 'unavailable'],
  ];
  for (const [label, response, kind] of kinds) {
    const c = new RpcClient({ baseUrl: 'http://127.0.0.1:1', fetchImpl: fakeFetch(() => response) });
    await assert.rejects(c.health(), (e: any) => e instanceof RpcError && e.kind === kind, label);
  }
  const slow = new RpcClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 50, fetchImpl: fakeFetch(() => ({ body: '{}', delay: 2000 })) });
  await assert.rejects(slow.health(), (e: any) => e.kind === 'timeout');
  assert.throws(() => parseHealth(null));
});

test('contract: every channel has a handler, a preload allowlist entry and no extras', async () => {
  const { CHANNELS } = await import('../shared/contract.js');
  const handlersSrc = readFileSync(new URL('../../src/core/handlers.ts', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('../main/preload.cjs', import.meta.url), 'utf8');
  const names = Object.values(CHANNELS);
  assert.equal(new Set(names).size, names.length, 'channel names are unique');
  for (const c of names) {
    assert.ok(handlersSrc.includes(`'${c}':`), `handler for ${c}`);
    assert.ok(preload.includes(`"${c}"`), `preload allows ${c}`);
  }
  const allowed = JSON.parse(/new Set\((\[.*?\])\)/.exec(preload)![1]!) as string[];
  assert.deepEqual([...allowed].sort(), [...names].sort(), 'preload allowlist equals the contract');
  // nothing in the contract can read files, run commands or return secrets
  for (const c of names) assert.ok(!/(shell|spawn|run-command|eval|read-file|write-file|fs:|secret|private|phrase-get|export-key|reveal)/.test(c), `${c} looks dangerous`);
});

test('electron main process: security policy is configured', () => {
  const src = readFileSync(new URL('../../src/main/main.ts', import.meta.url), 'utf8');
  for (const needle of ['contextIsolation: true', 'nodeIntegration: false', 'sandbox: true', 'webSecurity: true', "setWindowOpenHandler(() => ({ action: 'deny' }))", "'will-navigate'", 'will-attach-webview', 'setPermissionRequestHandler', "connect-src 'none'", 'requestSingleInstanceLock', 'trustedSender']) {
    assert.ok(src.includes(needle), `main.ts must contain ${needle}`);
  }
  assert.ok(!/nodeIntegration:\s*true|contextIsolation:\s*false|sandbox:\s*false|webSecurity:\s*false|enableRemoteModule/.test(src), 'no insecure webPreferences');
  const html = readFileSync(new URL('../../renderer/index.html', import.meta.url), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.ok(!/<script(?![^>]*src=)/.test(html), 'no inline scripts');
  assert.ok(!/ on[a-z]+=/.test(html), 'no inline event handlers');
});

test('renderer: html templates escape everything interpolated', async () => {
  const spec = '../web/renderer/dom.js';
  const dom: any = await import(spec);
  const evil = '<img src=x onerror=alert(1)>"\'`&';
  const out = dom.html`<td>${evil}</td>`.toString();
  assert.ok(!out.includes('<img'), out);
  assert.ok(out.includes('&#60;img'));
  assert.equal(dom.html`${dom.html`<b>${'<i>'}</b>`}`.toString(), '<b>&#60;i&#62;</b>');
  assert.equal(dom.html`${[1, '<', null, false]}`.toString(), '1&#60;');
});

test('external links: only this organisation\u2019s GitHub repositories, never a dot segment or an encoded one', async () => {
  const { isAllowedExternalLink } = await import('../core/handlers.js');
  for (const ok of ['https://github.com/EmoluxLabs/Obsidian-Network', 'https://github.com/EmoluxLabs/Obsidian-Network/releases/tag/desktop-v1.0.0-rc.2', 'https://github.com/EmoluxLabs/Obsidian-Network/issues?q=open']) {
    assert.equal(isAllowedExternalLink(ok), true, ok);
  }
  for (const bad of [
    'http://github.com/EmoluxLabs/Obsidian-Network', 'https://github.com/Other/x', 'https://github.com.evil.test/EmoluxLabs/x', 'https://evil.test/https://github.com/EmoluxLabs/x',
    'https://github.com/EmoluxLabs/x/../../someone/else', 'https://github.com/EmoluxLabs/..', 'https://github.com/EmoluxLabs/x/%2e%2e/%2e%2e/someone',
    'https://github.com/EmoluxLabs/x%2f..%2f..%2fo', 'https://github.com/EmoluxLabs/x\\..\\o', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user@github.com/EmoluxLabs/x', 'https://github.com/EmoluxLabs/x y',
  ]) {
    assert.equal(isAllowedExternalLink(bad), false, bad);
  }
});
