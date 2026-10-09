// Checks on the BUILT extension. Run `npm run build` first (the CI job and `npm test` after a build do).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const dist = path.join(root, 'dist');
const appWeb = path.join(root, '..', 'obsidian-app-web', 'public');
const built = fs.existsSync(path.join(dist, 'manifest.json'));
const t = (name, fn) => test(name, { skip: built ? false : 'dist/ not built (npm run build)' }, fn);
const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

t('the design files are byte-for-byte the template\u2019s', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-'));
  execFileSync('unzip', ['-q', path.join(root, 'template', 'obsidian-extension.zip'), '-d', scratch]);
  for (const f of ['popup.js', 'popup.css', 'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png']) {
    assert.equal(sha(path.join(dist, f)), sha(path.join(scratch, f)), f);
  }
});

t('the behaviour is obsidian-app-web\u2019s, copied, not forked', () => {
  const modules = fs.readdirSync(appWeb).filter((f) => f.endsWith('.mjs'));
  assert.ok(modules.length >= 7);
  for (const f of modules) assert.equal(sha(path.join(dist, f)), sha(path.join(appWeb, f)), f);
  assert.equal(sha(path.join(dist, 'js/obsidian.js')), sha(path.join(appWeb, 'js/obsidian.js')));
});

t('every file in the manifest exists in dist', () => {
  const m = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
  for (const f of [m.action.default_popup.split('?')[0], m.options_ui.page, m.background.service_worker, ...Object.values(m.icons), ...Object.values(m.action.default_icon)]) {
    assert.ok(fs.existsSync(path.join(dist, f)), f);
  }
});

t('every relative import resolves inside dist', () => {
  for (const file of walk(dist).filter((f) => /\.(mjs|js)$/.test(f) && !f.endsWith('popup.js') && !f.endsWith('obsidian.js'))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const [, spec] of src.matchAll(/(?:from|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      assert.ok(fs.existsSync(path.resolve(path.dirname(file), spec)), `${path.relative(dist, file)} imports ${spec}`);
    }
    // absolute imports must stay on the extension origin and exist
    for (const [, spec] of src.matchAll(/(?:from|import\(|BUNDLE_URL =)\s*['"](\/[^'"]+)['"]/g)) assert.ok(fs.existsSync(path.join(dist, spec)), `${path.relative(dist, file)} imports ${spec}`);
  }
});

t('HTML: only own scripts, no inline script, no inline handler, no remote resource', () => {
  for (const file of walk(dist).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(file, 'utf8');
    for (const [, attrs, body] of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
      assert.match(attrs, /\ssrc="[^":/]+"/, `${path.basename(file)}: script must be a local file`);
      assert.equal(body.trim(), '', 'no inline script');
    }
    assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline event handler attribute');
    assert.ok(!/(?:src|href)\s*=\s*"(?:https?:)?\/\//i.test(html), 'no remote resource');
  }
});

t('no remote code, eval or dynamic Function anywhere in the shipped JavaScript', () => {
  for (const file of walk(dist).filter((f) => /\.(mjs|js)$/.test(f))) {
    const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
    const rel = path.relative(dist, file);
    assert.ok(!/\beval\s*\(/.test(src), `${rel}: eval(`);
    assert.ok(!/new\s+Function\s*\(/.test(src), `${rel}: new Function(`);
    assert.ok(!/importScripts\s*\(/.test(src), `${rel}: importScripts`);
    assert.ok(!/import\(\s*['"]https?:/.test(src), `${rel}: remote import`);
    assert.ok(!/<script[^>]+src=["']https?:/i.test(src), `${rel}: remote script tag`);
  }
});

t('nothing in the extension\u2019s own code stores or posts a secret', () => {
  for (const f of fs.readdirSync(path.join(root, 'src'))) {
    const src = fs.readFileSync(path.join(root, 'src', f), 'utf8');
    assert.ok(!/privateKey|mnemonic|recoveryPhrase|passphrase/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'[^'\n]*'/g, "''")), `${f} must not handle secrets`);
  }
});

t('no mock or demo data from the design file is reachable from production code', () => {
  for (const f of ['real.mjs', 'data.mjs', 'screens.mjs', 'explorer.mjs', 'main.mjs', 'ext-screens.mjs', 'host.mjs']) {
    const src = fs.readFileSync(path.join(dist, f), 'utf8');
    assert.ok(!/OBS-FOUN-D001|OBS-TIME-2026|OBS-BETA-0001|satoshi\.obs|DEMO ONLY/.test(src), f);
  }
});

t('the package zip has manifest.json at its root and exactly the dist files', () => {
  execFileSync('node', [path.join(root, 'scripts', 'package.mjs')], { stdio: 'pipe' });
  const version = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8')).version;
  const zip = path.join(root, 'release', `obsidian-extension-${version}.zip`);
  const listed = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n').sort();
  const expected = walk(dist).map((f) => path.relative(dist, f).split(path.sep).join('/')).sort();
  assert.deepEqual(listed, expected);
  assert.ok(listed.includes('manifest.json'));
  const first = sha(zip);
  execFileSync('node', [path.join(root, 'scripts', 'package.mjs')], { stdio: 'pipe' });
  assert.equal(sha(zip), first, 'packaging is deterministic');
  assert.equal(fs.readFileSync(`${zip}.sha256`, 'utf8').split(' ')[0], first);
});
