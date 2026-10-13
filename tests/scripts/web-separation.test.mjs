/**
 * The three websites are three sites: deployment/web-separation.
 *
 * obsmainnet.us.ci -> 8789 (platform), app.obsmainnet.us.ci -> 8790 (Web App), wallet.obsmainnet.us.ci -> 8791 (Wallet
 * web app). These tests read the shipped nginx files, unit files, env examples and scripts and check that they agree
 * with each other and with the code: a hostname can only reach its own upstream, no vhost leans on the default site,
 * HTTP always goes to HTTPS, and the ports the files name are the ports the services really default to.
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = join(ROOT, 'deployment', 'web-separation');
const read = (p) => readFileSync(join(DIR, p), 'utf8');
const strip = (text) => text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

const SITES = [
  { host: 'obsmainnet.us.ci', upstream: 'obsidian_platform', port: 8789 },
  { host: 'app.obsmainnet.us.ci', upstream: 'obsidian_app', port: 8790 },
  { host: 'wallet.obsmainnet.us.ci', upstream: 'obsidian_wallet', port: 8791 },
];

test('each hostname has its own vhost, its own certificate and only its own upstream', () => {
  const seenCerts = new Set();
  for (const site of SITES) {
    const text = strip(read(`nginx/sites-available/${site.host}.conf`));
    const servers = text.split(/^server \{/m).slice(1);
    assert.equal(servers.length, 2, `${site.host}: one port-80 server and one port-443 server`);
    const [plain, tls] = servers;
    for (const block of servers) {
      assert.deepEqual([...block.matchAll(/server_name\s+([^;]+);/g)].map((m) => m[1].trim()), [site.host], `${site.host}: exactly its own server_name`);
      assert.doesNotMatch(block, /default_server/, `${site.host}: must not lean on (or become) the default site`);
    }
    assert.match(plain, /return 301 https:\/\/\$host\$request_uri;/, `${site.host}: plain HTTP goes to HTTPS`);
    assert.doesNotMatch(plain, /proxy_pass/, `${site.host}: nothing is served over plain HTTP`);
    assert.match(tls, /listen 443 ssl/);
    const cert = tls.match(/ssl_certificate\s+([^;]+);/)[1];
    assert.equal(cert, `/etc/letsencrypt/live/${site.host}/fullchain.pem`);
    assert.equal(tls.match(/ssl_certificate_key\s+([^;]+);/)[1], `/etc/letsencrypt/live/${site.host}/privkey.pem`);
    seenCerts.add(cert);
    const upstreams = [...tls.matchAll(/proxy_pass\s+http:\/\/([a-z_]+)/g)].map((m) => m[1]);
    assert.ok(upstreams.length > 0 && upstreams.every((u) => u === site.upstream), `${site.host}: only ${site.upstream}, got ${upstreams}`);
    assert.doesNotMatch(tls, /proxy_pass\s+http:\/\/\d/, 'a vhost names an upstream, never a raw port');
    assert.match(tls, /include snippets\/obsidian-proxy\.conf;/);
    assert.doesNotMatch(tls, /return 30[12]/, 'no redirect to /mine/, /app/ or /wallet/');
  }
  assert.equal(seenCerts.size, 3);
});

test('the upstream file names loopback ports 8789, 8790 and 8791 and nothing else', () => {
  const text = strip(read('nginx/conf.d/obsidian-web.conf'));
  const ups = Object.fromEntries([...text.matchAll(/upstream (\w+)\s+\{ server ([\d.]+):(\d+);/g)].map((m) => [m[1], [m[2], Number(m[3])]]));
  for (const site of SITES) assert.deepEqual(ups[site.upstream], ['127.0.0.1', site.port], site.upstream);
  assert.equal(Object.keys(ups).length, 3);
  assert.equal(new Set(Object.values(ups).map((u) => u[1])).size, 3, 'three different ports');
  assert.match(text, /limit_req_zone \$binary_remote_addr zone=obsidian_auth/);
  assert.match(text, /limit_req_zone \$binary_remote_addr zone=obsidian_api/);
});

test('the proxy headers the services trust are all set, and no WebSocket upgrade is promised', () => {
  const text = strip(read('nginx/snippets/obsidian-proxy.conf'));
  for (const h of ['Host $host', 'X-Forwarded-For $proxy_add_x_forwarded_for', 'X-Forwarded-Proto $scheme', 'X-Real-IP $remote_addr']) {
    assert.ok(text.includes(`proxy_set_header ${h};`), h);
  }
  assert.match(text, /proxy_set_header Connection "";/);
  // The Web App compares Origin with Host: Host must be the public hostname, not the internal address.
  assert.doesNotMatch(text, /proxy_set_header Host (127|\$proxy_host)/);
});

test('the wallet vhost exposes the API only through the wallet upstream, and the services bind loopback', () => {
  const wallet = strip(read('nginx/sites-available/wallet.obsmainnet.us.ci.conf'));
  assert.doesNotMatch(wallet, /location \/api\/auth/, 'no sign-in route on the wallet host');
  for (const f of ['env/platform.env.example', 'env/app-web.env.example', 'env/wallet-web.env.example']) {
    const text = read(f);
    assert.match(text, /^(OBSIDIAN_INTERFACE_HOST|APP_HOST)=127\.0\.0\.1$/m, `${f} binds loopback`);
  }
  assert.match(read('env/platform.env.example'), /^OBSIDIAN_INTERFACE_PORT=8789$/m);
  assert.match(read('env/app-web.env.example'), /^APP_PORT=8790$/m);
  assert.match(read('env/wallet-web.env.example'), /^APP_PORT=8791$/m);
  for (const f of ['env/app-web.env.example', 'env/wallet-web.env.example']) {
    assert.match(read(f), /^OBSIDIAN_PLATFORM_URL=http:\/\/127\.0\.0\.1:8789$/m, `${f} fronts the platform on 8789`);
  }
});

test('the ports in the files are the ports the services themselves default to', () => {
  const networks = readFileSync(join(ROOT, 'obsidian-app-web', 'server', 'networks.mjs'), 'utf8');
  assert.match(networks, /mainnet[\s\S]{0,300}appPort:\s*8790/);
  assert.match(readFileSync(join(ROOT, 'obsidian-wallet-web', 'scripts', 'start.mjs'), 'utf8'), /mainnet: 8791/);
  // The app server must not default to a public address.
  assert.match(readFileSync(join(ROOT, 'obsidian-app-web', 'server', 'main.mjs'), 'utf8'), /process\.env\.APP_HOST \?\? '127\.0\.0\.1'/);
});

test('the unit templates run one network each, read their own env file and bind nothing public', () => {
  for (const [file, env, dir] of [['obsidian-app-web@.service', 'app-web.env', 'obsidian-app-web'], ['obsidian-wallet-web@.service', 'wallet-web.env', 'obsidian-wallet-web']]) {
    const text = strip(read(`systemd/${file}`));
    assert.match(text, new RegExp(`EnvironmentFile=/etc/obsidian/%i/${env}`));
    assert.match(text, new RegExp(`WorkingDirectory=/opt/obsidian/${dir}`));
    assert.match(text, /ExecStart=\/usr\/bin\/node scripts\/start\.mjs %i/);
    assert.match(text, /NoNewPrivileges=true/);
    assert.match(text, /User=obsidian/);
    assert.ok(existsSync(join(ROOT, dir, 'scripts', 'start.mjs')), `${dir}/scripts/start.mjs exists`);
  }
});

// --- the scripts, against a scratch tree and a stand-in for nginx ---------------------------------------------------

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'obs-web-'));
  for (const d of ['etc/nginx/sites-available', 'etc/nginx/sites-enabled', 'etc/nginx/conf.d', 'etc/nginx/snippets', 'etc/obsidian/mainnet', 'etc/systemd/system']) mkdirSync(join(dir, d), { recursive: true });
  for (const s of SITES) {
    mkdirSync(join(dir, 'etc/letsencrypt/live', s.host), { recursive: true });
    for (const f of ['fullchain.pem', 'privkey.pem']) writeFileSync(join(dir, 'etc/letsencrypt/live', s.host, f), '');
  }
  writeFileSync(join(dir, 'etc/nginx/nginx.conf'), 'events {}\nhttp { include conf.d/*.conf; }\n');
  writeFileSync(join(dir, 'etc/nginx/sites-available/old'), 'server { listen 80; server_name obsmainnet.us.ci; }\n');
  symlinkSync('../sites-available/old', join(dir, 'etc/nginx/sites-enabled/old'));
  writeFileSync(join(dir, 'etc/obsidian/mainnet/interface.env'), 'OBSIDIAN_INTERFACE_PORT=8788\nKEEP=me\n');
  writeFileSync(join(dir, 'app-web.env'), '');
  const fake = join(dir, 'fake-nginx');
  writeFileSync(fake, '#!/bin/bash\nexit ${FAKE_NGINX_RC:-0}\n');
  chmodSync(fake, 0o755);
  return { dir, fake };
}
const run = (script, args, { dir, fake }, extra = {}) => spawnSync('bash', [join(DIR, 'scripts', script), ...args], {
  encoding: 'utf8', env: { ...process.env, OBS_ROOT: dir, NGINX_BIN: fake, ...extra },
});
const snapshot = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.name === 'var') continue; if (e.isDirectory()) walk(p); else out.push(p.slice(dir.length) + ':' + (e.isSymbolicLink() ? 'link' : readFileSync(p, 'utf8').length)); } };
  walk(dir);
  return out.sort();
};

test('install refuses to leave an old vhost answering for one of the three hostnames, and changes nothing', () => {
  const t = scratch();
  try {
    const before = snapshot(t.dir);
    const r = run('install.sh', [], t);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /already claim one of the three hostnames/);
    assert.deepEqual(snapshot(t.dir), before, 'nothing was changed');
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test('install backs up first, writes the ports from the env files, and rollback restores the tree exactly', () => {
  const t = scratch();
  try {
    const before = snapshot(t.dir);
    const r = run('install.sh', ['--disable-conflicts'], t);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const up = readFileSync(join(t.dir, 'etc/nginx/conf.d/obsidian-web.conf'), 'utf8');
    assert.match(up, /obsidian_platform \{ server 127\.0\.0\.1:8788;/, 'the platform port follows interface.env');
    assert.match(up, /obsidian_app      \{ server 127\.0\.0\.1:8790;/);
    for (const s of SITES) assert.ok(existsSync(join(t.dir, 'etc/nginx/sites-enabled', `${s.host}.conf`)), s.host);
    assert.ok(!existsSync(join(t.dir, 'etc/nginx/sites-enabled/old')), 'the conflicting vhost is out of load order');
    const backups = readdirSync(join(t.dir, 'var/backups/obsidian-web'));
    assert.equal(backups.length, 1);
    const bk = join(t.dir, 'var/backups/obsidian-web', backups[0]);
    assert.ok(existsSync(join(bk, 'nginx.tar')) && existsSync(join(bk, 'etc-obsidian.tar')));
    const rb = run('rollback.sh', [bk], t);
    assert.equal(rb.status, 0, rb.stdout + rb.stderr);
    assert.deepEqual(snapshot(t.dir), before, 'every file is back as it was');
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test('a failing `nginx -t` restores the previous configuration by itself', () => {
  const t = scratch();
  try {
    const before = snapshot(t.dir);
    const r = run('install.sh', ['--disable-conflicts'], t, { FAKE_NGINX_RC: '1' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /restoring the backup/);
    assert.deepEqual(snapshot(t.dir), before);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test('install refuses without a certificate, and refuses two services on the same port', () => {
  const t = scratch();
  try {
    rmSync(join(t.dir, 'etc/letsencrypt/live/app.obsmainnet.us.ci/privkey.pem'));
    const r = run('install.sh', ['--disable-conflicts'], t);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no certificate file .*app\.obsmainnet\.us\.ci\/privkey\.pem/);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
  const u = scratch();
  try {
    writeFileSync(join(u.dir, 'etc/obsidian/mainnet/app-web.env'), 'APP_PORT=8788\n');
    const r = run('install.sh', ['--disable-conflicts'], u);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /three ports must differ/);
  } finally { rmSync(u.dir, { recursive: true, force: true }); }
});

test('the shell scripts parse', () => {
  for (const f of readdirSync(join(DIR, 'scripts'))) {
    const r = spawnSync('bash', ['-n', join(DIR, 'scripts', f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});
