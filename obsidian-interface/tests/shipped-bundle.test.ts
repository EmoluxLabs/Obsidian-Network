import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const repo = resolve(root, '..');

/**
 * The other suites test the page source. This one tests the file a browser is
 * actually served, because that is where the wallet bug survived twice: once
 * because the source defaulted to the mainnet prefix, and once because a
 * cached copy of the old bundle kept being used after the fix shipped.
 */
describe('the shipped wallet bundle', () => {
  const bundle = resolve(root, 'public/js/wallet.js');

  it.runIf(existsSync(bundle))('derives from the connected network, with no mainnet default', () => {
    const js = readFileSync(bundle, 'utf8');
    // Creation passes the network's prefix through explicitly.
    expect(js).toContain('Wallet.create(network.addressHrp');
    expect(js).toContain('Wallet.fromPhrase(phrase.value.trim(), network.addressHrp');
    // And nothing reintroduces a literal mainnet prefix as a derivation input.
    expect(js).not.toMatch(/addressFromPublicKey\([^)]*,\s*["']obs["']\)/);
    expect(js).not.toMatch(/Wallet\.(create|fromPhrase)\([^)]*["']obs["']/);
  });

  it.runIf(existsSync(bundle))('is referenced by a URL that matches its own bytes', () => {
    // Cache busting is only honest if the hash in the markup is the hash of
    // the file on disk; otherwise an upgrade can still serve a stale bundle.
    const digest = createHash('sha256').update(readFileSync(bundle)).digest('hex').slice(0, 16);
    const shell = resolve(repo, 'wallet/index.html');
    if (!existsSync(shell)) return;
    expect(readFileSync(shell, 'utf8')).toContain(`/js/wallet.js?v=${digest}`);
  });
});

describe('the discontinued products ship nothing at all', () => {
  it('has no bundle, no site directory and no built page for Circle, Capsules or Social', () => {
    for (const page of ['circle', 'capsule', 'social']) {
      expect(existsSync(resolve(root, 'public', 'js', `${page}.js`)), `public/js/${page}.js`).toBe(false);
      expect(existsSync(resolve(root, 'web', 'src', 'pages', `${page}.ts`)), `web/src/pages/${page}.ts`).toBe(false);
      expect(existsSync(resolve(repo, page, 'index.html')), `${page}/index.html`).toBe(false);
    }
  });

  it('cannot be reached through the interface proxy, so a removed product is not a hidden API', async () => {
    const server = readFileSync(resolve(root, 'server', 'index.ts'), 'utf8');
    for (const route of ['/land/search', '/land/parcels', '/capsules', '/social/feed']) {
      expect(server, `${route} is still in the proxy allowlist`).not.toContain(`'${route}'`);
    }
  });
});
