#!/usr/bin/env node
/**
 * Live adversarial probe of the whole stack, through the app server, the way a stranger on the internet reaches it.
 *
 *   APP_URL=http://127.0.0.1:38790 PLATFORM_URL=http://127.0.0.1:38788 GENESIS_CODE=OBS-GENESIS-XXXX-XXXX-XXXX-XXXX \
 *     node tests/e2e-adversarial.mjs
 *
 * The platform rate-limits per client address. Behind the app server every visitor is one address, so a script that
 * hammers it would only measure its own throttling. With PLATFORM_URL set (and the platform started with
 * OBSIDIAN_INTERFACE_TRUST_PROXY=true, which a development stack may do), the account steps talk to the platform
 * directly, each step as its own client address; the steps that are about the app server itself (proxy allowlist,
 * origin policy, headers, framing, static files) always go through APP_URL. Without PLATFORM_URL everything goes
 * through the app and the throttle will answer 429 to the later steps, which then say so rather than pass.
 *
 * Needs a running node, platform and app server on one DEVELOPMENT network and a platform with a fresh data directory
 * (it consumes the genesis invitation). Not part of `npm test`. It creates disposable accounts and sends no
 * transaction. Every check is something the system must REFUSE, and the final assertion of each is the state of the
 * system (still up, nothing created), not the wording of the refusal.
 */
import { createHmac } from 'node:crypto';
import net from 'node:net';
import assert from 'node:assert/strict';

const APP = (process.env.APP_URL ?? 'http://127.0.0.1:38790').replace(/\/$/, '');
const PLATFORM = (process.env.PLATFORM_URL ?? '').replace(/\/$/, '');
const GENESIS = process.env.GENESIS_CODE;
if (!GENESIS) { console.error('GENESIS_CODE is required (a fresh platform)'); process.exit(2); }
const PASS = 'correct horse battery staple 42';
const results = [];
let viaApp = false; let clientIp = '203.0.113.1'; let stepNo = 0;
const step = async (name, fn, { app = false } = {}) => {
  viaApp = app || !PLATFORM; clientIp = `203.0.113.${(stepNo += 1)}`;
  try { await fn(); results.push([true, name]); console.log(`  ok   ${name}`); }
  catch (error) { results.push([false, name]); console.log(`  FAIL ${name}\n       ${String(error.message).split('\n').slice(0, 4).join('\n       ')}`); }
};

async function call(method, path, body, { cookie, headers = {}, raw, forceApp = false } = {}) {
  const init = { method, headers: { ...headers }, redirect: 'manual' };
  if (cookie) init.headers.cookie = cookie;
  if (raw !== undefined) { init.body = raw; } else if (body !== undefined) { init.headers['content-type'] ??= 'application/json'; init.body = JSON.stringify(body); }
  if (!viaApp && !forceApp) init.headers['x-forwarded-for'] ??= clientIp;
  let r;
  try { r = await fetch(`${viaApp || forceApp ? APP : PLATFORM}${path}`, init); } catch (error) {
    // A server may cut the connection of an oversized upload before it has been sent; that is a refusal, not a crash
    // (the steps that matter check that the process is still answering afterwards).
    return { status: 0, json: undefined, text: String(error?.cause?.code ?? error.message), headers: new Headers(), setCookie: [], session: undefined };
  }
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { /* not json */ }
  const setCookie = r.headers.getSetCookie?.() ?? [];
  const session = setCookie.map((c) => c.split(';')[0]).find((c) => c.startsWith('obsidian_session=') && c.length > 'obsidian_session='.length);
  return { status: r.status, json, text, headers: r.headers, setCookie, session };
}
const alive = async () => assert.equal((await call('GET', '/healthz', undefined, { forceApp: true })).status, 200, 'the app server is down');
const platformAlive = async () => { const r = await call('GET', '/api/health'); assert.ok(r.status === 200, `platform down (${r.status})`); };
const totp = (secret, at = Date.now()) => {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const c of secret.replace(/[\s=]/g, '').toUpperCase()) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const mac = createHmac('sha1', key).update(counter).digest(); const o = mac[19] & 15;
  return String((((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3]) % 1_000_000).padStart(6, '0');
};
const raws = (port, text) => new Promise((done) => {
  const s = net.connect(port, '127.0.0.1', () => s.write(text)); let d = '';
  s.on('data', (x) => { d += x; }); s.on('close', () => done(d)); s.setTimeout(2500, () => s.destroy());
});
let n = 0; const gmail = () => `adv.probe.${Date.now()}.${++n}@gmail.com`;

console.log(`adversarial probe of ${APP}`);
const me = { email: gmail() };

await step('registration: no invitation, a made-up invitation and the genesis code without the right shape are all refused', async () => {
  for (const inviteCode of [undefined, '', 'OBS-INVITE-0000-0000', 'x'.repeat(5000), 'OBS-GENESIS-AAAA-BBBB-CCCC-DDDD']) {
    const r = await call('POST', '/api/auth/register', { email: gmail(), password: PASS, inviteCode });
    assert.ok(r.status === 403 || r.status === 400, `${String(inviteCode).slice(0, 20)} -> ${r.status}`);
  }
  assert.equal((await call('GET', '/api/auth/config')).json.accountsExist, false, 'nothing was created');
});

await step('body fuzz: wrong types, prototype keys, nesting, oversize and invalid JSON never produce a 5xx or end a process', async () => {
  const bodies = [null, [], 0, 1e400, 'str', true, {}, { email: {} }, { email: [] , password: 1 }, { email: 'a@gmail.com', password: {}, inviteCode: 5 },
    { email: 'a@gmail.com', password: PASS, inviteCode: [GENESIS] }, { email: 'a@gmail.com', password: PASS, inviteCode: { trim: 1 } },
    JSON.parse('{"__proto__":{"admin":true},"email":"a@gmail.com"}'), { constructor: { prototype: { x: 1 } } },
    { email: 'a@gmail.com'.padEnd(200000, 'a') }, JSON.parse('['.repeat(2000) + ']'.repeat(2000))];
  const paths = ['/api/auth/register', '/api/auth/login', '/api/auth/recover', '/api/auth/mfa/setup', '/api/auth/mfa/confirm', '/api/auth/invites', '/api/auth/logout', '/api/wallet/link/challenge', '/api/wallet/link', '/api/nodes/refresh'];
  const bad = []; let throttled = 0; let fuzzIp = 0;
  for (const path of paths) for (const body of bodies) {
    let payload; try { payload = JSON.stringify(body); } catch { payload = 'null'; }
    const r = await call('POST', path, undefined, { raw: payload, headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.${(fuzzIp += 1) >> 8 & 255}.${fuzzIp & 255}` } });
    if (r.status === 429) throttled += 1;
    if (r.status >= 500) bad.push(`${path} ${payload.slice(0, 40)} -> ${r.status}`);
    if (/at .*\(.*:\d+:\d+\)|node_modules|\/home\//.test(r.text)) bad.push(`${path} leaked a stack/path`);
  }
  for (const raw of ['{', '{"a":', '\u0000', '\ufeff{}', '{"a":1}{"b":2}', 'x'.repeat(2_000_000)]) {
    for (const path of ['/api/auth/login', '/api/auth/register']) {
      const r = await call('POST', path, undefined, { raw, headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.${(fuzzIp += 1) >> 8 & 255}.${fuzzIp & 255}` } });
      if (r.status === 429) throttled += 1;
      if (r.status >= 500) bad.push(`${path} raw ${raw.slice(0, 12)} -> ${r.status}`);
    }
  }
  await alive(); await platformAlive();
  assert.deepEqual(bad, []);
  if (!PLATFORM) assert.equal(throttled, 0, `${throttled} requests were throttled before they could be inspected; set PLATFORM_URL`);
});

let genesis; // { cookie, recoveryCodes }
await step('genesis registration works once; the same code cannot be used again, by anyone, in parallel', async () => {
  const racers = await Promise.all(Array.from({ length: 6 }, (_, i) => call('POST', '/api/auth/register', { email: i === 0 ? me.email : gmail(), password: PASS, inviteCode: GENESIS })));
  const ok = racers.filter((r) => r.status === 200 || r.status === 201);
  assert.equal(ok.length, 1, `exactly one genesis registration may win, got ${ok.length}: ${racers.map((r) => r.status)}`);
  genesis = { cookie: ok[0].session, recoveryCodes: ok[0].json?.recoveryCodes };
  assert.ok(genesis.cookie, 'a session cookie');
  const flags = ok[0].setCookie.join(';');
  assert.match(flags, /HttpOnly/i); assert.match(flags, /SameSite=(Lax|Strict)/i);
  assert.equal((await call('POST', '/api/auth/register', { email: gmail(), password: PASS, inviteCode: GENESIS })).status, 403);
});

await step('the genesis code cannot be used as an ordinary invitation, nor ordinary codes as genesis', async () => {
  const r = await call('POST', '/api/auth/register', { email: gmail(), password: PASS, inviteCode: GENESIS.toLowerCase() });
  assert.ok(r.status === 403, `lower-cased genesis code -> ${r.status}`);
});

await step('a normal invitation is single-use even under a parallel race', async () => {
  const inv = await call('POST', '/api/auth/invites', {}, { cookie: genesis.cookie });
  assert.equal(inv.status, 201, JSON.stringify(inv.json));
  const code = inv.json.invite.code;
  const racers = await Promise.all(Array.from({ length: 10 }, () => call('POST', '/api/auth/register', { email: gmail(), password: PASS, inviteCode: code })));
  const ok = racers.filter((r) => r.status === 200 || r.status === 201);
  assert.equal(ok.length, 1, `exactly one account per invitation, got ${ok.length}: ${racers.map((r) => r.status)}`);
});

await step('invitations are capped per account, however fast they are asked for', async () => {
  const cap = (await call('GET', '/api/auth/config')).json.maxInvitesPerAccount;
  const all = await Promise.all(Array.from({ length: cap + 8 }, () => call('POST', '/api/auth/invites', {}, { cookie: genesis.cookie })));
  const made = all.filter((r) => r.status === 201).length;
  const listed = (await call('GET', '/api/auth/invites', undefined, { cookie: genesis.cookie })).json;
  assert.ok(listed.invites.length <= cap, `${listed.invites.length} invitations exist, cap is ${cap} (${made} created now)`);
  assert.ok(listed.issued <= cap);
});

await step('registration validation: weak passwords, non-Gmail, look-alike and dotted/plus variants of a taken address', async () => {
  const inv = await call('POST', '/api/auth/invites', {}, { cookie: genesis.cookie });
  const code = inv.json?.invite?.code ?? 'OBS-X';
  for (const [email, password] of [['x@yahoo.com', PASS], ['x@gmail.com', 'short'], ['x@gmail.com.evil.test', PASS], ['x@@gmail.com', PASS], [' x@gmail.com\r\nBcc: a@b.c', PASS], [me.email.replace('@', '+tag@'), PASS], [me.email.toUpperCase(), PASS], [me.email.replace(/\./g, '').replace('@', '.@'), PASS]]) {
    const r = await call('POST', '/api/auth/register', { email, password, inviteCode: code });
    assert.notEqual(r.status === 200 || r.status === 201, true, `${email} was accepted`);
  }
});

await step('login: unknown account and wrong password are indistinguishable', async () => {
  const a = await call('POST', '/api/auth/login', { email: gmail(), password: PASS });
  const b = await call('POST', '/api/auth/login', { email: me.email, password: PASS + 'x' });
  assert.equal(a.status, b.status);
  assert.equal(a.json?.error, b.json?.error);
  assert.equal(a.json?.code, b.json?.code);
  assert.equal(a.session, undefined); assert.equal(b.session, undefined);
});

await step('sessions: tampered, truncated, empty and duplicate cookies are not sessions', async () => {
  const token = genesis.cookie.split('=')[1];
  for (const cookie of ['obsidian_session=' + token.slice(0, -1), 'obsidian_session=' + token + 'x', 'obsidian_session=', 'obsidian_session=' + token.toUpperCase(), 'obsidian_session=../../etc', 'x=1']) {
    assert.equal((await call('GET', '/api/auth/me', undefined, { cookie })).status, 401, cookie.slice(0, 30));
  }
  assert.equal((await call('GET', '/api/auth/me', undefined, { cookie: genesis.cookie })).status, 200);
});

await step('MFA: a wrong code is refused, a right one is accepted, and the same code cannot be used twice', async () => {
  const setup = await call('POST', '/api/auth/mfa/setup', {}, { cookie: genesis.cookie });
  assert.equal(setup.status, 200, JSON.stringify(setup.json));
  const secret = setup.json.secret ?? setup.json.mfa?.secret;
  assert.ok(secret, 'a TOTP secret');
  const wrong = await call('POST', '/api/auth/mfa/confirm', { totp: '000000' }, { cookie: genesis.cookie });
  assert.ok(wrong.status >= 400 && wrong.status < 500);
  const code = totp(secret);
  const confirm = await call('POST', '/api/auth/mfa/confirm', { totp: code }, { cookie: genesis.cookie });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.json));
  // replay: the same 30-second code, presented at sign-in straight afterwards
  const first = await call('POST', '/api/auth/login', { email: me.email, password: PASS, totp: code });
  const second = await call('POST', '/api/auth/login', { email: me.email, password: PASS, totp: code });
  assert.ok(!(first.session && second.session), `the same TOTP code signed in twice (${first.status}, ${second.status})`);
  genesis.secret = secret;
});

await step('sign-in with MFA needs the code; guessing codes is throttled', async () => {
  const noCode = await call('POST', '/api/auth/login', { email: me.email, password: PASS });
  assert.equal(noCode.session, undefined, 'signed in without the second factor');
  let wins = 0; let throttled = 0;
  for (let i = 0; i < 60; i += 1) {
    const r = await call('POST', '/api/auth/login', { email: me.email, password: PASS, totp: String(100000 + i * 7919 % 900000) });
    if (r.session) wins += 1; if (r.status === 429) throttled += 1;
  }
  assert.equal(wins, 0, 'a guessed code signed in');
  assert.ok(throttled > 0, 'sixty wrong codes in a row were never throttled');
});

await step('recovery codes are single-use and wrong ones are refused', async () => {
  const codes = genesis.recoveryCodes ?? [];
  assert.ok(codes.length > 0, 'recovery codes were issued');
  assert.notEqual((await call('POST', '/api/auth/recover', { email: me.email, recoveryCode: 'AAAA-BBBB-CCCC', newPassword: PASS + 'Z1!newer' })).status, 200);
  assert.equal(codes.length, new Set(codes).size, 'recovery codes are distinct');
});

await step('wallet link: needs a session; a bad address, wrong network and unsigned proof link nothing', async () => {
  assert.equal((await call('POST', '/api/wallet/link/challenge', { address: 'dobs1abc' })).status, 401);
  assert.equal((await call('POST', '/api/wallet/link', { address: 'dobs1abc', publicKey: '00', signature: '00' })).status, 401);
  const login = await call('POST', '/api/auth/login', { email: me.email, password: PASS, totp: totp(genesis.secret, Date.now() + 30000) });
  const cookie = login.session ?? genesis.cookie;
  for (const address of ['obs1' + 'q'.repeat(38), 'dobs1' + 'q'.repeat(38), 'tobs1' + 'q'.repeat(38), '', 'dobs1', 'DOBS1' + 'Q'.repeat(38), "dobs1'; DROP TABLE accounts;--", 5, null, ['dobs1x']]) {
    const r = await call('POST', '/api/wallet/link/challenge', { address }, { cookie });
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(address).slice(0, 30)} -> ${r.status}`);
  }
  const me2 = (await call('GET', '/api/auth/me', undefined, { cookie })).json.account;
  assert.ok(!me2.wallet && !me2.walletAddress && !me2.address, 'no wallet got linked');
});

await step('the proxy never reaches a route outside its allowlist (dot segments, encodings, smuggled queries)', async () => {
  const bad = [];
  const paths = ['/tx/../metrics', '/tx/%2e%2e/metrics', '/tx/..%2fmetrics', '/block/../../etc/passwd', '//metrics', '/metrics', '/admin', '/debug', '/debug/pprof', '/config', '/keys', '/wallet/../metrics', '/status/../metrics', '/status%00', '/status\r\nX-Injected: 1', '/names?x=1#/../metrics', '\\metrics', '/tx/\\..\\metrics', 'http://169.254.169.254/latest/meta-data/', '//169.254.169.254/', '@169.254.169.254', '/status@evil.test', '/rpc', '/p2p', '/peers/add', '/mining/claims/../../metrics'];
  for (const p of paths) {
    const r = await call('GET', `/api/rpc?path=${encodeURIComponent(p)}`);
    if (r.status === 200 && !/^\/(status|names)/.test(p)) bad.push(`${p} -> 200 ${r.text.slice(0, 60)}`);
    if (/prometheus|# HELP|root:|ami-id/.test(r.text)) bad.push(`${p} leaked`);
    if (r.headers.get('x-injected')) bad.push('header injection');
  }
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const r = await call(method, '/api/rpc?path=/tx/submit', { tx: 'aa' });
    if (r.status === 200) bad.push(`${method} accepted`);
  }
  assert.deepEqual(bad, []);
}, { app: true });

await step('the proxy relays only the writes it lists, and refuses an unsigned or undecodable submission without a session', async () => {
  for (const p of ['/status', '/mining/status', '/names', '/blocks', '/block/1', '/tx/abc', '/address/dobs1x', '/health']) {
    const r = await call('POST', `/api/rpc?path=${encodeURIComponent(p)}`, {});
    assert.ok(r.status >= 400, `${p} accepted a POST (${r.status})`);
  }
  for (const body of [{}, { tx: '' }, { tx: 'zz' }, { tx: 'aa' }, { tx: 'a'.repeat(2_000_000) }, { tx: 5 }, { tx: [] }]) {
    const r = await call('POST', '/api/rpc?path=/tx/submit', body);
    assert.ok(r.status >= 400 && r.status < 500, `submit ${JSON.stringify(body).slice(0, 30)} -> ${r.status}`);
  }
}, { app: true });

await step('cross-site: a state-changing call with a foreign, null or hidden origin is refused at the app server', async () => {
  for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { origin: APP.replace('127.0.0.1', 'localhost') + '.evil.test' }]) {
    const r = await call('POST', '/api/auth/logout', {}, { cookie: genesis.cookie, headers });
    assert.equal(r.status, 403, JSON.stringify(headers));
  }
  assert.equal((await call('GET', '/api/auth/me', undefined, { cookie: genesis.cookie })).status, 200, 'the refused logouts did not end the session');
}, { app: true });

await step('framing and sniffing protections are on every page', async () => {
  for (const p of ['/', '/real.mjs', '/api/health']) {
    const r = await call('GET', p);
    assert.match(r.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/, p);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', p);
  }
}, { app: true });

await step('files outside public/ and dotfiles are not served', async () => {
  for (const p of ['/package.json', '/server/main.mjs', '/../package.json', '/%2e%2e/package.json', '/.env', '/.git/config', '/node_modules/jsqr/package.json', '/tests/server.test.mjs', '/scripts/start.mjs']) {
    const r = await call('GET', p);
    assert.ok(!/"name": "obsidian-app-web"|createServer|OBSIDIAN_PLATFORM_URL|\[core\]/.test(r.text), `${p} leaked source`);
  }
}, { app: true });

await step('request smuggling and malformed framing do not reach the platform or end the process', async () => {
  const port = new URL(APP).port;
  const attacks = [
    'POST /api/auth/login HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\nContent-Length: 40\r\nConnection: close\r\n\r\n{}{}',
    'POST /api/auth/login HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\nGET /api/auth/me HTTP/1.1\r\nHost: x\r\n\r\n',
    'GET / HTTP/1.1\r\nHost: x\r\nX-A: b\x00c\r\nConnection: close\r\n\r\n',
    'GET /' + 'a'.repeat(100000) + ' HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n',
    'GET / HTTP/1.1\r\n' + 'X: y\r\n'.repeat(5000) + 'Host: x\r\nConnection: close\r\n\r\n',
    'CONNECT evil.test:443 HTTP/1.1\r\nHost: evil.test:443\r\n\r\n',
    'TRACE / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n',
  ];
  for (const a of attacks) {
    const text = await raws(port, a);
    assert.ok(!/^HTTP\/1\.1 2\d\d[\s\S]*HTTP\/1\.1 2\d\d/.test(text), 'a second request rode on the first');
  }
  await alive(); await platformAlive();
}, { app: true });

await step('the node-refresh endpoint is throttled, so it cannot be used to flood the nodes', async () => {
  const rs = await Promise.all(Array.from({ length: 12 }, () => call('POST', '/api/nodes/refresh', {})));
  assert.ok(rs.some((r) => r.status === 429), `no 429 in ${rs.map((r) => r.status)}`);
}, { app: true });

await step('slow-loris style: a stalled request does not block other clients', async () => {
  const port = Number(new URL(APP).port);
  const stalled = Array.from({ length: 50 }, () => { const s = net.connect(port, '127.0.0.1'); s.write('POST /api/auth/login HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n{'); s.on('error', () => {}); return s; });
  const t = Date.now();
  const r = await call('GET', '/healthz');
  stalled.forEach((s) => s.destroy());
  assert.equal(r.status, 200); assert.ok(Date.now() - t < 2000);
}, { app: true });

await step('logout ends the session on the server, and the old cookie is dead', async () => {
  const login = await call('POST', '/api/auth/login', { email: me.email, password: PASS, totp: totp(genesis.secret, Date.now() + 60000) });
  const cookie = login.session ?? genesis.cookie;
  assert.equal((await call('POST', '/api/auth/logout', {}, { cookie })).status, 200);
  assert.equal((await call('GET', '/api/auth/me', undefined, { cookie })).status, 401, 'the cookie still works after logout');
});

const failed = results.filter(([ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks held`);
process.exit(failed.length ? 1 : 0);
