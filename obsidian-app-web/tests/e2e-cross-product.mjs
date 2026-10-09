#!/usr/bin/env node
/**
 * Live: is this app and the Obsidian Web platform ONE system?
 *
 *   APP_URL=http://127.0.0.1:38790 PLATFORM_URL=http://127.0.0.1:38788 \
 *   GENESIS_CODE=OBS-GENESIS-XXXX-XXXX-XXXX-XXXX \
 *     node tests/e2e-cross-product.mjs
 *
 * Needs a running node, platform and app for the SAME network, a platform with a fresh
 * data dir (the accounts part consumes the genesis invitation — leave GENESIS_CODE unset
 * to run only the claims part), a built bundle (`npm run build:web`) and a built
 * obsidian-interface (its esbuild is used to run the platform's own code). It sends real
 * transactions, so it is for a development network. It is not part of `npm test`.
 *
 * The two products are driven by their own real code:
 *   product A  the platform's web/src/lib/{wallet,operations,client}.ts, bundled here
 *   product B  this app's public/wallet.mjs and public/data.mjs, through the app server
 *
 * What it proves, against a real chain:
 *   1. accounts   an account made through either product signs in through the other
 *   2. claims     a claim made through either product is on the one ledger, shows in both
 *                 products' views, and blocks a second claim through the other — including
 *                 a claim forged past BOTH products' client-side checks, straight to the chain
 *   3. replay     the identical bytes cannot be claimed twice
 *   4. race       both products claiming at once yields exactly one claim
 *   5. names      a .obs name registered through either product cannot be registered again
 *                 through the other, under either spelling
 *
 * Every check on the chain asserts final LEDGER STATE, not how a rejection was worded: the
 * chain is the authority, so the number of claims it holds is the answer.
 */

import { createHmac } from 'node:crypto';
import { createRequire, register } from 'node:module';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const APP = (process.env.APP_URL ?? 'http://127.0.0.1:38790').replace(/\/$/, '');
const PLATFORM = (process.env.PLATFORM_URL ?? 'http://127.0.0.1:38788').replace(/\/$/, '');
const GENESIS = process.env.GENESIS_CODE;
// The platform now refuses a mining claim unless it comes from a signed-in account that is
// MFA-confirmed and has the signing wallet linked. The claims part therefore needs such an
// account: the accounts part creates one when GENESIS_CODE is set; otherwise pass the session
// cookie of one as MINER_COOKIE (e.g. `obsidian_session=…`).
let minerCookie = process.env.MINER_COOKIE ?? '';
const PASS = 'correct horse battery staple';
const STANDARD_PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = 0;
const say = (text) => console.log(`${String(++step).padStart(2, '0')}  ${text}`);

// ── browser plumbing: one fetch, relative URLs mean "the app", with its own cookie jar ──

const bundleFile = resolve(here, '../public/js/obsidian.js');
if (!existsSync(bundleFile)) throw new Error('run `npm run build:web` first');
register(
  `data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, n) {
    if (s === '/js/obsidian.js') return { url: ${JSON.stringify(pathToFileURL(bundleFile).href)}, shortCircuit: true };
    return n(s, c);
  }`)}`,
);

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

/** A cookie jar per origin, as a browser keeps one. */
class Jar {
  cookies = '';
  absorb(res) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const name = pair.split('=')[0];
      this.cookies = this.cookies.split('; ').filter((c) => c && !c.startsWith(`${name}=`)).concat(pair).join('; ');
    }
  }
}
const jars = { [APP]: new Jar(), [PLATFORM]: new Jar() };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const target = String(url).startsWith('/') ? APP + url : String(url);
  const origin = target.startsWith(PLATFORM) ? PLATFORM : APP;
  const jar = jars[origin];
  const res = await realFetch(target, { ...init, headers: { ...(init.headers ?? {}), cookie: jar.cookies } });
  jar.absorb(res);
  return res;
};

/** A raw call to one product's HTTP API, as its own browser would make it. */
async function api(base, method, path, body, jar = jars[base]) {
  const res = await realFetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', cookie: jar.cookies, origin: base },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  jar.absorb(res);
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* leave null */
  }
  return { status: res.status, data };
}

const data = await import('../public/data.mjs');
const appWallet = await import('../public/wallet.mjs');
const signing = await import('../web/signing.mjs');
const ops = await import('../web/ops.mjs');

// ── the platform's own code ──────────────────────────────────────────────────

const esbuild = createRequire(join(root, 'obsidian-interface', 'package.json'))('esbuild');
const tmp = mkdtempSync(join(tmpdir(), 'obs-cross-'));
await esbuild.build({
  stdin: {
    contents: `export { Wallet } from './lib/wallet.ts'; export { operations } from './lib/operations.ts'; export { ObsidianClient } from './lib/client.ts';`,
    resolveDir: join(root, 'obsidian-interface/web/src'),
    sourcefile: 'entry.ts',
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: join(tmp, 'platform.mjs'),
  logLevel: 'silent',
});
const platform = await import(pathToFileURL(join(tmp, 'platform.mjs')).href);
const client = new platform.ObsidianClient(PLATFORM);
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

// ── chain helpers (read through the APP, which is what a user of it sees) ───────

const net = (await data.getNetwork()).network;
const HRP = net.addressHrp;
const app = await data.getAppConfig();
assert.equal(app.network, net.name, 'the app and its node agree on the network');
say(`network ${net.name} (chain ${net.chainId}, ${HRP}1…) — app identity matches the node`);

const claimsOf = async (base, address) =>
  (await (await realFetch(`${base}/api/rpc?path=${encodeURIComponent(`/mining/claims?miner=${address}&limit=50`)}`)).json());

async function untilClaims(address, count, label) {
  for (let i = 0; i < 40; i += 1) {
    const { claims } = await claimsOf(APP, address);
    if (claims.length >= count) return claims;
    await sleep(1500);
  }
  throw new Error(`${label}: the chain never showed ${count} claim(s) for ${address}`);
}
const settle = async (blocks = 3) => {
  const start = (await data.getStatus()).height;
  for (let i = 0; i < 60; i += 1) {
    if ((await data.getStatus()).height >= start + blocks) return;
    await sleep(1500);
  }
};

/** The ledger's own count of claims for one address, after letting blocks pass. */
async function ledgerCount(address) {
  await settle(3);
  return (await claimsOf(APP, address)).claims.length;
}

const totp = (secret, at = Date.now()) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(Array.from({ length: Math.floor(bits.length / 8) }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
};

// ═════════════════════════════════════════════════════════════════════════════
// 1. ACCOUNTS — one system, two front doors
// ═════════════════════════════════════════════════════════════════════════════

if (GENESIS) {
  const stamp = Date.now().toString(36);
  const pw = 'correct horse battery 7 staple';
  const one = `xp.one.${stamp}@gmail.com`;
  const two = `xp.two.${stamp}@gmail.com`;
  const three = `xp.three.${stamp}@gmail.com`;

  // account one: created THROUGH THE APP, with the genesis invitation, MFA on
  await data.register({ email: one, password: pw, inviteCode: GENESIS });
  const mfa = await data.mfaSetup();
  await data.mfaConfirm(totp(mfa.secret));
  const inviteA = (await data.issueInvite()).invite.code;
  const inviteB = (await data.issueInvite()).invite.code;
  say(`app:      registered ${one} (genesis invitation), enabled MFA, issued two invitations`);

  // account two: created DIRECTLY ON THE PLATFORM, then signed into THROUGH THE APP
  const direct = await api(PLATFORM, 'POST', '/api/auth/register', { email: two, password: pw, inviteCode: inviteA });
  assert.equal(direct.status, 200, `platform register: ${JSON.stringify(direct.data)}`);
  const platformId = direct.data.account.id;
  jars[APP].cookies = ''; // a fresh browser on the app's origin
  await data.login({ email: two, password: pw });
  const viaApp = (await data.me()).account;
  assert.equal(viaApp.email, two);
  assert.equal(viaApp.id, platformId, 'the same account record, not a copy');
  say(`platform → app:  ${two} was created on the platform and signs into the app as the same account`);

  // account three: created THROUGH THE APP, then signed into DIRECTLY ON THE PLATFORM
  jars[APP].cookies = '';
  await data.register({ email: three, password: pw, inviteCode: inviteB });
  const appId = (await data.me()).account.id;
  jars[PLATFORM].cookies = '';
  const login = await api(PLATFORM, 'POST', '/api/auth/login', { email: three, password: pw });
  assert.equal(login.status, 200, `platform login: ${JSON.stringify(login.data)}`);
  const meThere = await api(PLATFORM, 'GET', '/api/auth/me');
  assert.equal(meThere.data.account.email, three);
  assert.equal(meThere.data.account.id, appId, 'the same account record, not a copy');
  say(`app → platform:  ${three} was created in the app and signs into the platform as the same account`);

  // account one (MFA): the platform demands the same second factor the app set up
  jars[PLATFORM].cookies = '';
  const noCode = await api(PLATFORM, 'POST', '/api/auth/login', { email: one, password: pw });
  assert.equal(noCode.data?.code, 'ERR_MFA_REQUIRED', 'the platform asks for the code the app enrolled');
  const withCode = await api(PLATFORM, 'POST', '/api/auth/login', { email: one, password: pw, totp: totp(mfa.secret, Date.now() + 30000) });
  assert.equal(withCode.status, 200, JSON.stringify(withCode.data));
  minerCookie = jars[PLATFORM].cookies; // account one: signed in, MFA confirmed — the account that mines below
  say(`app → platform:  the MFA secret enrolled in the app is accepted by the platform`);

  // a wrong password is wrong on both
  jars[PLATFORM].cookies = '';
  assert.equal((await api(PLATFORM, 'POST', '/api/auth/login', { email: two, password: 'wrong wrong wrong 1' })).status, 401);
  jars[APP].cookies = '';
  await assert.rejects(data.login({ email: two, password: 'wrong wrong wrong 1' }), { code: 'ERR_CREDENTIALS_INVALID' });
  say('both:      a wrong password is refused by both, with the platform’s own error code');

  // an invitation is single-use across both doors
  const reuse = await api(PLATFORM, 'POST', '/api/auth/register', { email: `xp.four.${stamp}@gmail.com`, password: pw, inviteCode: inviteA });
  assert.ok(reuse.status >= 400, 'a spent invitation cannot be used on the other door');
  say('both:      an invitation spent in one product is spent in the other');
} else {
  say('(GENESIS_CODE not set — skipping the accounts part)');
}

// ═════════════════════════════════════════════════════════════════════════════
// 2–4. CLAIMS — one ledger
// ═════════════════════════════════════════════════════════════════════════════

// Both doors act for ONE account (they share the platform's session cookie, as they share its
// accounts). A claim is accepted only from the wallet linked to that account, so each wallet is
// linked before it claims — through the app's own `linkWallet`, the route its Account screen uses.
if (!minerCookie) {
  console.log('claims need a signed-in, MFA-confirmed account: set GENESIS_CODE (fresh platform) or MINER_COOKIE');
  process.exit(2);
}
jars[APP].cookies = minerCookie;
jars[PLATFORM].cookies = minerCookie;
const linkFor = async (w) => {
  const linked = await data.linkWallet(w.address);
  assert.equal(linked.account?.walletAddress, w.address, 'the platform linked the wallet to the account');
};

// A signed-out caller cannot claim, whatever it holds: refused by the platform, and nothing on the ledger.
{
  const w = await freshWallet();
  const saved = { app: jars[APP].cookies, platform: jars[PLATFORM].cookies };
  jars[APP].cookies = '';
  jars[PLATFORM].cookies = '';
  const anonymous = await forgeClaim(w, 'signed out');
  assert.equal(anonymous.accepted, false, 'a signed-out claim must be refused');
  assert.equal(await ledgerCount(w.address), 0, 'nothing reached the ledger');
  jars[APP].cookies = saved.app;
  jars[PLATFORM].cookies = saved.platform;
  // signed in, but the wallet is not linked to the account: refused as well
  const unlinked = await forgeClaim(w, 'unlinked wallet');
  assert.equal(unlinked.accepted, false, 'a claim from a wallet that is not linked must be refused');
  assert.equal(await ledgerCount(w.address), 0, 'nothing reached the ledger');
  say('gate:     signed out → refused; signed in with a wallet that is not linked → refused; nothing on the ledger');
}

/** A fresh random wallet, usable by both products. */
async function freshWallet() {
  store.clear();
  const made = await platform.Wallet.create(HRP, PASS); // product A holds it in memory
  const phrase = made.revealPhrase();
  store.clear();
  await appWallet.setupWallet({ phrase, passphrase: PASS }); // product B seals it on "its" device
  return { phrase, platformWallet: made, address: made.address };
}

/** Product B's claim, as the app's Mine screen makes it. */
const claimViaApp = () => appWallet.claim(async () => PASS);
/** Product A's claim, as the platform's Mine page makes it. */
const claimViaPlatform = (w) => platform.operations.claim(client, w.platformWallet);

/** A claim forged PAST both products' eligibility checks, signed correctly, sent to the chain. */
async function forgeClaim(w, label) {
  const mining = await data.getMiningStatus(w.address);
  const status = await data.getStatus();
  const nonce = await appWallet.getNonce(w.address);
  const signed = signing.sign({
    wallet: signing.walletFromPhrase(w.phrase, HRP),
    chainId: net.chainId,
    protocolVersion: status.protocolVersion,
    nonce,
    type: signing.TxType.MINING_CLAIM,
    gas: 0n,
    body: signing.buildMiningBody({ claimId: mining.nextClaimId, claimSequence: mining.nextClaimSequence }),
    validUntil: status.lastBlockTimestamp + 600,
  });
  try {
    const result = await data.submitTransaction(signed.hex);
    return { sent: true, accepted: Boolean(result?.accepted ?? true), label };
  } catch (error) {
    return { sent: true, accepted: false, reason: error.code ?? error.message, label };
  }
}

// ── a claim through the PLATFORM first, then the app ─────────────────────────
{
  const w = await freshWallet();
  await linkFor(w);
  say(`wallet W1 ${w.address.slice(0, 14)}… (fresh, usable from both products)`);

  const first = await claimViaPlatform(w);
  assert.ok(first.txId, 'the platform’s claim was submitted');
  await untilClaims(w.address, 1, 'W1 via platform');
  say(`platform: W1 claimed (${first.txId.slice(0, 12)}…) — it is on the chain`);

  // the app's view of the same wallet agrees, and its own claim is refused
  assert.equal((await claimsOf(APP, w.address)).claims.length, 1, 'the app sees the platform’s claim');
  const second = await claimViaApp();
  assert.equal(second.ok, false, 'the app must refuse a second claim');
  assert.equal(second.reason, 'NOT_ELIGIBLE');
  say(`app:      W1's second claim refused up front — "${second.message}"`);

  // forge past the app's own check, straight at the chain
  const forged = await forgeClaim(w, 'forged-after-platform');
  say(`chain:    W1's forged second claim — ${forged.accepted ? 'taken into the mempool' : `refused (${forged.reason})`}`);

  // replay the exact bytes of the first
  assert.equal(await ledgerCount(w.address), 1, 'W1 has exactly ONE claim on the ledger after a platform claim + app attempt + forged claim');
  say('ledger:   W1 has exactly one claim — the second was stopped by the chain, not by either product');
}

// ── a claim through the APP first, then the platform ─────────────────────────
{
  const w = await freshWallet();
  await linkFor(w);
  say(`wallet W2 ${w.address.slice(0, 14)}… (fresh)`);

  const first = await claimViaApp();
  assert.equal(first.ok, true, `the app's claim: ${first.message}`);
  await untilClaims(w.address, 1, 'W2 via app');
  say(`app:      W2 claimed (${first.txId.slice(0, 12)}…) — it is on the chain`);

  assert.equal((await claimsOf(PLATFORM, w.address)).claims.length, 1, 'the platform sees the app’s claim');
  await assert.rejects(claimViaPlatform(w), /not eligible/i, 'the platform must refuse a second claim');
  say('platform: W2\'s second claim refused up front — the platform\'s own check sees the app\'s claim');

  const forged = await forgeClaim(w, 'forged-after-app');
  say(`chain:    W2's forged second claim — ${forged.accepted ? 'taken into the mempool' : `refused (${forged.reason})`}`);
  assert.equal(await ledgerCount(w.address), 1, 'W2 has exactly ONE claim on the ledger');
  say('ledger:   W2 has exactly one claim');

  // the same view from both products
  const a = await claimsOf(APP, w.address);
  const p = await claimsOf(PLATFORM, w.address);
  assert.deepEqual(a.claims, p.claims, 'both products show the same claim records');
  const global = await (await realFetch(`${APP}/api/rpc?path=${encodeURIComponent('/mining/claims?limit=50')}`)).json();
  assert.ok(global.claims.some((c) => c.txId === first.txId), 'the app’s claim is in the global list both explorers read');
  say('both:      the claim record is identical through the app and through the platform, and is in the global list');
}

// ── both products at once ────────────────────────────────────────────────────
{
  const w = await freshWallet();
  await linkFor(w);
  say(`wallet W3 ${w.address.slice(0, 14)}… (fresh) — both products claim at the same instant`);
  const [a, b] = await Promise.allSettled([claimViaApp(), claimViaPlatform(w)]);
  const accepted = [a, b].filter((r) => r.status === 'fulfilled' && (r.value.ok ?? true) && r.value.txId);
  assert.ok(accepted.length >= 1, 'at least one product got its claim in');
  if (accepted.length === 2 && accepted[0].value.txId === accepted[1].value.txId) {
    say('race:     both products built the SAME transaction (same id) — one transaction, submitted twice');
  } else {
    say(`race:     ${accepted.length} submission(s) accepted into the mempool`);
  }
  await untilClaims(w.address, 1, 'W3 race');
  assert.equal(await ledgerCount(w.address), 1, 'a simultaneous claim from both products is still exactly one claim');
  say('ledger:   W3 has exactly one claim');
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. NAMES — one registry
// ═════════════════════════════════════════════════════════════════════════════
{
  // The funded wallet: the standard test phrase holds the devnet genesis allocation.
  store.clear();
  const funded = await platform.Wallet.fromPhrase(STANDARD_PHRASE, HRP, PASS);
  store.clear();
  await appWallet.setupWallet({ phrase: STANDARD_PHRASE, passphrase: PASS });
  const fee = (await data.getParams()).ons.registrationFeeObs;
  const tag = Date.now().toString(36).replace(/[^a-z0-9]/g, '');

  const record = async (name) => {
    try {
      return await data.getName(`${name}.obs`);
    } catch {
      return null;
    }
  };
  const until = async (name, label) => {
    for (let i = 0; i < 40; i += 1) {
      const r = await record(name);
      if (r) return r;
      await sleep(1500);
    }
    throw new Error(`${label}: ${name}.obs never appeared on the chain`);
  };

  // registered through the PLATFORM (it sends the suffix it is given)…
  const viaPlatformName = `xpa-${tag}`;
  await platform.operations.registerName(client, funded, { name: `${viaPlatformName}.obs`, feeObs: fee });
  const original = await until(viaPlatformName, 'platform registration');
  say(`platform: registered ${viaPlatformName}.obs at block ${original.registeredAtHeight}`);

  // …cannot be registered again through the APP, bare or suffixed
  for (const spelling of [viaPlatformName, `${viaPlatformName}.obs`.toUpperCase()]) {
    const again = await appWallet.registerName({ name: spelling.toLowerCase(), feeObs: fee }, async () => PASS);
    assert.equal(again.ok, false, `the app must refuse "${spelling}"`);
    assert.equal(again.reason, 'NAME_TAKEN');
  }
  say('app:      registering it again (either spelling) is refused up front — NAME_TAKEN');

  // forced past the app's check, straight to the chain
  const status = await data.getStatus();
  const forgedBytes = signing.sign({
    wallet: signing.walletFromPhrase(STANDARD_PHRASE, HRP),
    chainId: net.chainId,
    protocolVersion: status.protocolVersion,
    nonce: await appWallet.getNonce(funded.address),
    type: signing.TxType.ONS,
    gas: signing.expectedGas(ops.parseObs(fee)),
    body: signing.buildOnsBody({ op: signing.OnsOp.REGISTER, name: viaPlatformName, fee: ops.parseObs(fee) }),
    validUntil: status.lastBlockTimestamp + 600,
  });
  const forced = await data.submitTransaction(forgedBytes.hex).then(() => 'taken into the mempool', (e) => `refused (${e.code ?? e.message})`);
  await settle(3);
  const after = await record(viaPlatformName);
  assert.equal(after.registeredAtHeight, original.registeredAtHeight, 'the registration was not replaced');
  assert.equal(after.expiresAt, original.expiresAt, 'and was not extended or re-registered');
  say(`chain:    a forged re-registration was ${forced}; the name's record is unchanged`);

  // registered through the APP… and the PLATFORM (which has no such check) cannot take it
  const viaAppName = `xpb-${tag}`;
  const ok = await appWallet.registerName({ name: viaAppName, feeObs: fee }, async () => PASS);
  assert.equal(ok.ok, true, `the app's registration: ${ok.message}`);
  const mine = await until(viaAppName, 'app registration');
  say(`app:      registered ${viaAppName}.obs at block ${mine.registeredAtHeight}`);
  const platformTry = await platform.operations
    .registerName(client, funded, { name: `${viaAppName}.obs`, feeObs: fee })
    .then(() => 'taken into the mempool', (e) => `refused (${e.message})`);
  await settle(3);
  const kept = await record(viaAppName);
  assert.equal(kept.registeredAtHeight, mine.registeredAtHeight);
  assert.equal(kept.expiresAt, mine.expiresAt);
  say(`chain:    the platform's attempt at the app's name was ${platformTry}; the record is unchanged`);

  // both products read the same registry
  const names = (await (await realFetch(`${PLATFORM}/api/rpc?path=${encodeURIComponent('/names?limit=50')}`)).json()).names.map((n) => n.name);
  assert.ok(names.includes(`${viaPlatformName}.obs`) && names.includes(`${viaAppName}.obs`), 'both names are in the one registry');
  say('both:      both names are in the registry both products read');
}

console.log('\ne2e-cross-product: all checks passed');
