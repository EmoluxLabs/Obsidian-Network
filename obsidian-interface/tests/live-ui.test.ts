// @vitest-environment jsdom
/**
 * Live UI test: real pages, real node, real HTTP.
 *
 * The other page tests answer fixtures. This one starts an actual Obsidian Core
 * node (the built artifact, not a mock) on loopback ports, points the browser
 * modules at it, and asserts what the pages render. It exists because the class
 * of bug it catches is invisible to unit tests: the interface read
 * `medianPriceUsd`, `commitment`, `transactionCount` and `glvUsdMicro` — fields
 * no node has ever sent — so pages printed `undefined`, `0 OBS` and `$0.00`
 * beside a perfectly healthy chain.
 *
 * Requirements: `npm run build` (or at least `npm run build:core`) must have run,
 * because this test executes obsidian-core/dist/index.js.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { webcrypto } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const HERE = resolve(__dirname, '..');
const CORE = resolve(HERE, '..', 'obsidian-core');
const CORE_ENTRY = join(CORE, 'dist', 'index.js');
const DEVNET_CONFIG = join(CORE, 'config', 'devnet.json');

/** The real fetch, captured before the stub replaces globalThis.fetch. */
const nodeFetch: typeof fetch = globalThis.fetch.bind(globalThis);

const RPC_PORT = 39830;
const P2P_PORT = 39831;
const NODE_URL = `http://127.0.0.1:${RPC_PORT}`;

let child: ChildProcess | undefined;
let dataDir = '';

async function waitForNode(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${NODE_URL}/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = (error as Error).message;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error(`the test node never became healthy: ${lastError}`);
}

beforeAll(async () => {
  if (!existsSync(CORE_ENTRY)) {
    throw new Error(
      `obsidian-core is not built (${CORE_ENTRY} is missing). Run "npm run build:core" (or "npm run build") first: this test drives the real page modules against a real node.`,
    );
  }
  dataDir = mkdtempSync(join(tmpdir(), 'obsidian-live-ui-'));
  child = spawn(
    process.execPath,
    [CORE_ENTRY, 'start', '--config', DEVNET_CONFIG, '--offline'],
    {
      cwd: CORE,
      env: {
        ...process.env,
        OBSIDIAN_DATA_DIR: join(dataDir, 'data'),
        OBSIDIAN_KEYSTORE_PATH: join(dataDir, 'node-key.json'),
        OBSIDIAN_KEYSTORE_PASSPHRASE: 'live-ui-test-passphrase',
        OBSIDIAN_RPC_PORT: String(RPC_PORT),
        OBSIDIAN_P2P_PORT: String(P2P_PORT),
        OBSIDIAN_LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stderr?.on('data', () => undefined);
  child.stdout?.on('data', () => undefined);
  await waitForNode();
  // Blocks are produced on the production interval (5s on devnet): wait for a
  // couple so the explorer has a real chain to read rather than an empty one.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const status = (await (await nodeFetch(`${NODE_URL}/status`)).json()) as { height: number };
    if (status.height >= 2) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error('the test node did not produce blocks');
}, 120_000);

afterAll(async () => {
  if (child && !child.killed) {
    child.kill('SIGTERM');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    if (!child.killed) child.kill('SIGKILL');
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

/**
 * Point the pages at the real node.
 *
 * Pages request `/api/rpc?path=…` from their own origin (the interface server in
 * production). Here there is no interface server, so the stub maps those paths
 * onto the node's own HTTP API — the same mapping the interface performs, minus
 * its node-selection logic. Everything else (status, blocks, land registry,
 * params, oracle, capsules) is answered by the node itself over TCP, and the
 * page code under test is the shipped browser module.
 */
function installLiveFetch(): void {
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const target = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    if (target.includes('/api/nodes')) {
      return new Response(
        JSON.stringify({
          nodes: [{ url: NODE_URL, healthy: true, height: 1, latestBlockHash: '', chainId: 7780, networkId: 'obsidian-devnet-1', peers: 0, latencyMs: 1 }],
          consensusHeight: 1,
          genesisMismatch: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (target.includes('/api/auth/')) {
      return new Response(JSON.stringify({ error: 'sign in required', code: 'ERR_UNAUTHORIZED' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (/^https?:\/\//.test(target)) return nodeFetch(target, init);
    const rpcIndex = target.indexOf('/api/rpc?path=');
    if (rpcIndex >= 0) {
      const path = decodeURIComponent(target.slice(rpcIndex + '/api/rpc?path='.length));
      return nodeFetch(`${NODE_URL}${path}`, init);
    }
    return nodeFetch(`${NODE_URL}${target.startsWith('/') ? target : `/${target}`}`, init);
  });
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
  document.body.innerHTML = '<div id="app"></div>';
  window.localStorage.clear();
  window.location.hash = '';
  installLiveFetch();
  // Without this the page module stays cached from the previous test, keeps its
  // module-scope DOM nodes (now detached) and renders into nothing.
  vi.resetModules();
});

const settle = () => new Promise((resolvePromise) => setTimeout(resolvePromise, 400));

/** Poll a selector until its text satisfies `ok`, so a slow block never flakes a test. */
async function waitForText(selector: string, ok: (text: string) => boolean, timeoutMs = 8000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    text = document.querySelector(selector)?.textContent ?? '';
    if (ok(text)) return text;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
  return text;
}

describe('browser pages against a live node', () => {
  it('landing shows the chain\'s real numbers, not placeholders', async () => {
    const status = (await (await fetch(`${NODE_URL}/status`)).json()) as { height: number; supplyObs: string; peers: number };
    await import('../web/src/pages/landing.js');
    await settle();

    const stats = document.querySelector('#stats')?.textContent ?? '';
    expect(stats).toContain(`${status.height}`);
    expect(stats).toContain('21,000,000');                     // hard cap, from /status
    expect(stats).toContain('0.001');                          // daily reward, from /mining/schedule
    expect(stats).toContain('0.00016666');                     // per-claim reward, exact seals
    // The landing page no longer shows any price feed: protocol fees are
    // denominated in OBS, so it shows the actual fee instead of a quote.
    expect(stats).toContain('0.05');
    expect(stats).not.toContain('no price yet');
    expect(stats).not.toMatch(/\$\d/);
    expect(document.body.textContent ?? '').not.toContain('priced in dollars');
    expect(stats).not.toContain('undefined');
    expect(stats).not.toContain('— OBS');
  });

  it('explorer lists real blocks with transaction counts and byte sizes', async () => {
    const { blocks } = (await (await fetch(`${NODE_URL}/blocks?limit=5`)).json()) as {
      blocks: Array<{ height: number; txCount: number; size: number }>;
    };
    expect(blocks.length).toBeGreaterThan(0);

    await import('../web/src/pages/explorer.js');
    await settle();

    const table = document.querySelector('#blocks')?.textContent ?? '';
    expect(table).toContain(String(blocks[0].height));
    expect(table).toContain(`${blocks[0].size} B`);
    expect(table).not.toContain('undefined');
    expect(table).not.toContain('NaN');

    const stats = document.querySelector('#chain-stats')?.textContent ?? '';
    expect(stats).toContain('21,000,000 OBS');                  // supply line, read from this node
    expect(stats).toContain('dobs1');                           // the network's address prefix
  });

  it('explorer renders the decentralisation report, never "[object Object]"', async () => {
    // Regression: the panel rendered `String(value)` over /audit/decentralization,
    // whose `questions` and `centralisedDependencies` are arrays of objects. The
    // page showed a row of "[object Object],[object Object],…" to every visitor.
    const audit = (await (await fetch(`${NODE_URL}/audit/decentralization`)).json()) as {
      questions: Array<{ question: string; answer: string }>;
      centralisedDependencies: Array<{ component: string }>;
    };
    expect(audit.questions.length).toBeGreaterThan(0);
    expect(audit.centralisedDependencies.length).toBeGreaterThan(0);

    await import('../web/src/pages/explorer.js');
    await settle();

    const stats = document.querySelector('#chain-stats')?.textContent ?? '';
    expect(stats).not.toContain('[object Object]');
    expect(stats).toContain(audit.questions[0].question);
    expect(stats).toContain(audit.centralisedDependencies[0].component);
    expect(stats).toContain('Centralised dependencies');
    expect(stats).not.toContain('undefined');
  });

  it('explorer renders a real block detail by height', async () => {
    const status = (await (await fetch(`${NODE_URL}/status`)).json()) as { height: number };
    // The page reads the hash once, when it boots (deep links from the block table).
    window.location.hash = `#/block/${status.height}`;
    await import('../web/src/pages/explorer.js');
    const detail = await waitForText('#explorer-result', (text) => text.includes(`Block ${status.height}`));
    expect(detail).toContain(`Block ${status.height}`);
    expect(detail).toContain('State root');
    expect(detail).not.toContain('undefined');
  });

  it('mine shows the schedule the node computes, with a live countdown', async () => {
    await import('../web/src/pages/mine.js');
    await settle();

    const schedule = document.querySelector('#schedule')?.textContent ?? document.body.textContent ?? '';
    expect(schedule).toContain('0.001');                        // reward per day now
    expect(schedule).toContain('0.00016666');                   // reward per claim now
    expect(schedule).toContain('0.5% per 100,000 active miners');
    expect(schedule).toContain('0.0002 OBS/day');               // hard floor
    expect(schedule).not.toContain('undefined');
  });

  it('circle lists the real registry: countries, GLVs and divisions', async () => {
    await import('../web/src/pages/circle.js');
    await settle();

    const atlas = document.querySelector('section.card')?.textContent ?? '';
    expect(atlas).toContain('Nigeria');
    // Land is priced in OBS: a dollar sign anywhere would mean the oracle
    // dependency came back.
    expect(atlas).toContain('OBS');
    expect(atlas).not.toContain('$');
    expect(atlas).not.toContain('No divisions configured');

    document.querySelector<HTMLButtonElement>('#country-NG')?.click();
    await settle();

    const detail = document.querySelector('#parcel-detail')?.textContent ?? '';
    expect(detail).toMatch(/NG-[A-Z]+|\(NG\)/);
    expect(detail).toContain('OBS');
    expect(detail).not.toContain('$');
    expect(detail).not.toContain('undefined');
  });

  it('capsule wall, ONS and social render empty states honestly on a fresh chain', async () => {
    // Static importers: a bundler cannot resolve a computed specifier, and a
    // skipped page would be a silent hole in this test.
    const pages: Array<[string, () => Promise<unknown>]> = [
      ['capsule', () => import('../web/src/pages/capsule.js')],
      ['ons', () => import('../web/src/pages/ons.js')],
      ['social', () => import('../web/src/pages/social.js')],
    ];
    for (const [page, load] of pages) {
      document.body.innerHTML = '<div id="app"></div>';
      await load();
      await settle();
      const text = document.body.textContent ?? '';
      expect(text, `${page} must not print undefined`).not.toContain('undefined');
      expect(text, `${page} must not print NaN`).not.toContain('NaN');
      expect(text.length, `${page} rendered almost nothing`).toBeGreaterThan(200);
    }
  });

  it('wallet creation stays in the browser even with a node reachable', async () => {
    await import('../web/src/pages/wallet.js');
    await settle();

    document.querySelector<HTMLInputElement>('#passphrase')!.value = 'a-long-enough-passphrase';
    document.querySelector<HTMLInputElement>('#passphrase-confirm')!.value = 'a-long-enough-passphrase';
    document.querySelector<HTMLButtonElement>('#create')!.click();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1200));

    const text = document.body.textContent ?? '';
    expect(text).toContain('OBS');                               // an address and a phrase were shown
    expect(Object.keys(window.localStorage)).toEqual(['obsidian.vault.v1']);
    const vault = window.localStorage.getItem('obsidian.vault.v1') ?? '';
    expect(vault).not.toContain('passphrase');
  });

  /**
   * Contract test. The pages read `/params` by field name, and those names
   * changed when protocol fees were repriced from USD into OBS. The fixtures
   * in `pages.test.ts` were updated to the new product behaviour but kept the
   * OLD field names, so the suite stayed green while the real ONS page read
   * `params.ons.registrationFeeUsd` — undefined on every real node — and
   * closed registration behind an oracle that no longer prices anything.
   *
   * This asserts the field names against a live node, which no fixture can
   * fake.
   */
  it('reads the fee fields the node actually sends, in OBS, with no USD anywhere', async () => {
    const params = (await (await nodeFetch(`${NODE_URL}/params`)).json()) as Record<string, Record<string, unknown>>;

    expect(typeof params.ons.registrationFeeObs).toBe('string');
    expect(typeof params.ons.renewalFeeObs).toBe('string');
    expect(typeof params.social.businessPagePriceObs).toBe('string');
    expect(typeof params.circle.minGlvObs).toBe('string');
    expect(typeof params.circle.maxGlvObs).toBe('string');
    expect(typeof params.consensus.minValidatorBondObs).toBe('string');

    // The old USD-denominated fee fields must be gone, not merely unused.
    expect(params.ons.registrationFeeUsd).toBeUndefined();
    expect(params.social.businessPagePriceUsd).toBeUndefined();

    // The repriced values the protocol now charges.
    expect(params.ons.registrationFeeObs).toBe('0.050000000000000000');
    expect(params.social.businessPagePriceObs).toBe('0.005000000000000000');
    expect(params.consensus.minValidatorBondObs).toBe('50.000000000000000000');
    expect(params.circle.minGlvObs).toBe('0.010000000000000000');
    expect(params.circle.maxGlvObs).toBe('5.000000000000000000');
  });

  it('prices name registration from the protocol, on a chain with no price feed', async () => {
    // This node has never received an oracle submission, which is the normal
    // state of a fresh chain. Registration must still be open and priced.
    const oracle = (await (await nodeFetch(`${NODE_URL}/oracle`)).json()) as { usable: boolean };
    expect(oracle.usable, 'the point of this test is a chain with no usable feed').toBe(false);

    await import('../web/src/pages/ons.js');
    await settle();
    const text = document.body.textContent ?? '';

    expect(text).toContain('0.05');
    expect(text).toContain('OBS');
    expect(text).not.toContain('registration is closed');
    expect(text).not.toMatch(/\$\d/);
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('NaN');
    expect(document.querySelector<HTMLButtonElement>('#ons-register')?.disabled).toBe(false);
  });

  it('creates an address for the network it is connected to, not for mainnet', async () => {
    // The node behind this test is devnet, so the address must be dobs1….
    // The page used to always derive the mainnet prefix, producing a wallet
    // every devnet node answers "not a valid address for this network" for.
    await import('../web/src/pages/wallet.js');
    await settle();

    document.querySelector<HTMLInputElement>('#passphrase')!.value = 'a-long-enough-passphrase';
    document.querySelector<HTMLInputElement>('#passphrase-confirm')!.value = 'a-long-enough-passphrase';
    document.querySelector<HTMLButtonElement>('#create')!.click();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1200));

    const vault = JSON.parse(window.localStorage.getItem('obsidian.vault.v1') ?? '{}') as {
      address: string;
      addressHrp?: string;
    };
    expect(vault.address.startsWith('dobs1'), `got ${vault.address}`).toBe(true);
    expect(vault.address.startsWith('obs1')).toBe(false);
    expect(vault.addressHrp).toBe('dobs');

    // And the node agrees it is addressable, rather than refusing it.
    const balance = await nodeFetch(`${NODE_URL}/wallet/balance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: vault.address }),
    });
    expect(balance.status).toBe(200);

    // The same query with the address the old code would have produced is
    // refused by the node — which is exactly what the user saw.
    const mainnetShaped = await nodeFetch(`${NODE_URL}/wallet/balance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'obs16ahf37l5ums7ln2q9kv5rc7rrufswn5d755ete' }),
    });
    expect(mainnetShaped.status).toBe(400);
  });

  it('warns instead of silently failing when the vault belongs to another network', async () => {
    await import('../web/src/pages/wallet.js');
    await settle();
    document.querySelector<HTMLInputElement>('#passphrase')!.value = 'a-long-enough-passphrase';
    document.querySelector<HTMLInputElement>('#passphrase-confirm')!.value = 'a-long-enough-passphrase';
    document.querySelector<HTMLButtonElement>('#create')!.click();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1200));

    // Rewrite the stored address to a mainnet one, exactly as a vault created
    // by the old code would look, and reopen the page.
    const stored = JSON.parse(window.localStorage.getItem('obsidian.vault.v1')!) as { address: string };
    stored.address = 'obs16ahf37l5ums7ln2q9kv5rc7rrufswn5d755ete';
    window.localStorage.setItem('obsidian.vault.v1', JSON.stringify(stored));

    document.body.innerHTML = '<div id="app"></div>';
    vi.resetModules();
    await import('../web/src/pages/wallet.js');
    await settle();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 600));

    const text = document.body.textContent ?? '';
    expect(text).toContain('This wallet is a mainnet wallet, but this interface is on devnet');
    expect(text).toContain('not a valid address for this network');  // names the error the user hit
    expect(text).toContain('re-derive');                             // and offers the way out
    expect(text).toContain('Wallet networkmainnet');
    expect(text).toContain('This interfacedevnet (chain 7780)');
    expect(text).not.toContain('undefined');
  });
}, 120_000);
