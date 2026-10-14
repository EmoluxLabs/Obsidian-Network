// @vitest-environment jsdom
/**
 * Paying a `.obs` name from the main interface's wallet page.
 *
 * The page's own module is driven in a DOM against a fake mainnet node (chain 7777, `obs1…`): nothing here is real OBS or real
 * chain state. What is pinned: a name is resolved from the node's ONS record and from nowhere else; the whole resolved
 * address is shown for confirmation before anything is signed; what is signed is that address and never the name; a failed
 * lookup stops with its own message; and `operations.send` itself refuses a name, so no other caller can serialise one.
 */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { operations } from '../web/src/lib/operations.js';
import { Wallet } from '../web/src/lib/wallet.js';
import type { ObsidianClient } from '../web/src/lib/client.js';
import { decodeSignedTxFromBytes } from '../web/core/transactions/encode.js';
import { decodePaymentBody } from '../web/core/transactions/executors/payment.js';
import { generateKeyPair } from '../web/core/crypto/keys.js';

const NOW = 1_800_000_000;
const PASSPHRASE = 'a passphrase long enough for the vault';
const OBS = 10n ** 18n;
const addressOn = (hrp: string) => generateKeyPair(hrp).address;
const REGISTERED = addressOn('obs');
const OWNER = addressOn('obs');
const NATIVE = addressOn('obs');

interface World {
  chainId: number;
  hrp: string;
  configChainId: number | null;
  names: Record<string, Record<string, unknown>>;
  lookup: ((name: string) => { status: number; body: unknown } | Error) | null;
}
let world: World;
const requested: string[] = [];
const submitted: string[] = [];

const freshWorld = (): World => ({
  chainId: 7777,
  hrp: 'obs',
  configChainId: 7777,
  names: {
    'obsidian.obs': {
      name: 'obsidian.obs', owner: OWNER, address: REGISTERED, registeredAt: NOW - 100, registeredAtHeight: 3,
      expiresAt: NOW + 31_536_000, transferCount: 0, resolved: true,
    },
  },
  lookup: null,
});

const response = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  text: async () => JSON.stringify(body),
  json: async () => body,
});

function node(url: string, init?: RequestInit) {
  requested.push(decodeURIComponent(url));
  if (url.startsWith('/api/auth/config')) {
    return response({ network: 'mainnet', chainId: world.configChainId, inviteOnly: true, authMethod: 'GMAIL_PASSWORD_MFA', emailDomains: [], passwordMinLength: 12, mfaRequiredForMining: true, recoveryCodeCount: 10, maxInvitesPerAccount: 5, accountsExist: true });
  }
  if (!url.startsWith('/api/rpc')) return response({ error: 'not found' }, 404);
  const path = decodeURIComponent(new URL(url, 'http://x').searchParams.get('path') ?? '');
  if (path === '/network') return response({ network: { name: 'mainnet', chainId: world.chainId, addressHrp: world.hrp } });
  if (path === '/status') return response({ height: 30, chainId: world.chainId, lastBlockTimestamp: NOW });
  if (path === '/wallet/balance') return response({ address: 'x', nonce: 4, balanceSeals: (10n * OBS).toString(), balanceObs: '10.000000000000000000' });
  if (path.startsWith('/wallet/') && path.endsWith('/history')) return response({ transactions: [] });
  if (path.startsWith('/names/')) {
    const name = path.slice('/names/'.length);
    if (world.lookup) {
      const out = world.lookup(name);
      if (out instanceof Error) throw out;
      return response(out.body, out.status);
    }
    const record = world.names[name];
    return record ? response(record) : response({ error: 'name not registered', code: 'ERR_NOT_FOUND', name }, 404);
  }
  if (path === '/tx/submit') {
    submitted.push(JSON.parse(String(init?.body)).tx);
    return response({ accepted: true, txId: 'ab'.repeat(32) });
  }
  return response({ error: 'not found', code: 'ERR_NOT_FOUND' }, 404);
}

const settle = () => new Promise((r) => setTimeout(r, 60));
const until = async (label: string, test: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!test()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const value = (id: string, v: string) => ((document.getElementById(id) as HTMLInputElement).value = v);
const text = () => document.body.textContent ?? '';
const toasts = () => [...document.querySelectorAll('.toast, [role="status"], [role="alert"]')].map((n) => n.textContent ?? '').join(' | ');

beforeEach(async () => {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
  world = freshWorld();
  requested.length = 0;
  submitted.length = 0;
  window.localStorage.clear();
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const target = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    return node(target, init);
  });
  // A wallet for this (mainnet) network, sealed in this browser, and the page opened and unlocked.
  const wallet = await Wallet.fromPhrase(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    'obs',
    PASSPHRASE,
  );
  expect(wallet.address.startsWith('obs1')).toBe(true);
  await import('../web/src/pages/wallet.js');
  await settle();
  (document.getElementById('unlock-passphrase') as HTMLInputElement).value = PASSPHRASE;
  document.getElementById('unlock')!.click();
  await until('the send form', () => Boolean(document.getElementById('send-button')));
}, 60_000);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const nameLookups = () => requested.filter((r) => r.includes('/names/'));
const click = async (id: string) => {
  document.getElementById(id)!.click();
  await settle();
};
const paid = () => {
  expect(submitted).toHaveLength(1);
  const tx = decodeSignedTxFromBytes(Uint8Array.from(Buffer.from(submitted[0]!, 'hex')));
  return { tx, body: decodePaymentBody(tx.body) };
};

describe('paying a native address', () => {
  it('is unchanged: no lookup, and the address is paid as typed', async () => {
    value('send-to', NATIVE);
    value('send-amount', '1.5');
    await click('send-button');
    await until('the payment', () => submitted.length === 1);
    expect(paid().body.to).toBe(NATIVE);
    expect(nameLookups()).toEqual([]);
    expect(document.getElementById('send-review')).toBeNull();
  }, 30_000);
});

describe('paying a .obs name', () => {
  it('resolves it, shows the name, the whole address, the network and the status — and signs nothing yet', async () => {
    value('send-to', '  Obsidian.OBS ');
    value('send-amount', '2');
    await click('send-button');
    await until('the review', () => Boolean(document.getElementById('send-review')));
    expect(submitted, 'resolving a name must never send').toHaveLength(0);
    expect(document.getElementById('send-review-name')!.textContent).toBe('obsidian.obs');
    expect(document.getElementById('send-review-address')!.textContent, 'the full address, unshortened').toBe(REGISTERED);
    expect(text()).toContain('Obsidian Mainnet');
    expect(text()).toContain('Registered on-chain');
    expect(text()).not.toContain(OWNER);
    expect(nameLookups()).toEqual(['/api/rpc?path=/names/obsidian.obs']);
  }, 30_000);

  it('confirming pays the resolved address, never the name, after resolving once more', async () => {
    value('send-to', 'obsidian.obs');
    value('send-amount', '2');
    await click('send-button');
    await until('the review', () => Boolean(document.getElementById('send-review')));
    await click('send-confirm');
    await until('the payment', () => submitted.length === 1);
    const { tx, body } = paid();
    expect(body.to).toBe(REGISTERED);
    expect(body.amount).toBe(2n * OBS);
    expect(tx.chainId).toBe(7777);
    expect(submitted[0]).not.toContain(Buffer.from('obsidian.obs').toString('hex'));
    expect(nameLookups()).toHaveLength(2);
  }, 30_000);

  it('blocks the payment if the name is repointed between review and confirmation', async () => {
    value('send-to', 'obsidian.obs');
    value('send-amount', '2');
    await click('send-button');
    await until('the review', () => Boolean(document.getElementById('send-review')));
    world.names['obsidian.obs']!.address = addressOn('obs');
    await click('send-confirm');
    await settle();
    expect(submitted).toHaveLength(0);
    expect(toasts()).toMatch(/different address/);
    expect(document.getElementById('send-review')).toBeNull();
  }, 30_000);

  it('cancel returns to the form and sends nothing', async () => {
    value('send-to', 'obsidian.obs');
    value('send-amount', '2');
    await click('send-button');
    await until('the review', () => Boolean(document.getElementById('send-review')));
    await click('send-cancel');
    expect(document.getElementById('send-review')).toBeNull();
    expect((document.getElementById('send-to') as HTMLInputElement).value).toBe('obsidian.obs');
    expect(submitted).toHaveLength(0);
  }, 30_000);

  const failures: Array<[string, string, () => void, string]> = [
    ['an unregistered name', 'nobody.obs', () => undefined, 'ONS name not found on Mainnet.'],
    ['a node that errors', 'obsidian.obs', () => { world.lookup = () => ({ status: 500, body: { error: 'boom' } }); }, 'Could not resolve this ONS name. Please try again.'],
    ['a lookup that throws', 'obsidian.obs', () => { world.lookup = () => new TypeError('network down'); }, 'Could not resolve this ONS name. Please try again.'],
    ['an answer that is not a record', 'obsidian.obs', () => { world.lookup = () => ({ status: 200, body: { hello: 'world' } }); }, 'The ONS lookup returned an unusable answer. Transaction blocked.'],
    ['an invalid resolved address', 'obsidian.obs', () => { world.names['obsidian.obs']!.address = 'obs1notanaddress'; }, 'ONS name resolved to an invalid OBS address. Transaction blocked.'],
    ['a testnet address', 'obsidian.obs', () => { world.names['obsidian.obs']!.address = addressOn('tobs'); }, 'ONS lookup came from a different network than Obsidian Mainnet. Transaction blocked.'],
    ['a node on another chain', 'obsidian.obs', () => { world.chainId = 7778; }, 'ONS lookup came from a different network than Obsidian Mainnet. Transaction blocked.'],
    ['an interface that is not tied to a chain', 'obsidian.obs', () => { world.configChainId = null; }, 'Could not resolve this ONS name. Please try again.'],
    ['an expired name', 'obsidian.obs', () => { world.names['obsidian.obs']!.expiresAt = NOW; }, 'This ONS name has expired, so its address is no longer trusted. Transaction blocked.'],
    ['a malformed name', 'foo bar.obs', () => undefined, 'That is not a valid ONS name. Use 3–63 letters, numbers or interior hyphens, then .obs.'],
  ];
  for (const [label, typed, arrange, message] of failures) {
    it(`stops with its own message for ${label}`, async () => {
      arrange();
      value('send-to', typed);
      value('send-amount', '1');
      await click('send-button');
      await settle();
      expect(toasts()).toContain(message);
      expect(document.getElementById('send-review')).toBeNull();
      expect(submitted).toHaveLength(0);
      if (label === 'a malformed name') expect(nameLookups()).toEqual([]);
    }, 30_000);
  }

  it('does not call a failed lookup an invalid address', async () => {
    world.lookup = () => ({ status: 502, body: { error: 'bad gateway' } });
    value('send-to', 'obsidian.obs');
    value('send-amount', '1');
    await click('send-button');
    await settle();
    expect(toasts()).not.toMatch(/invalid/i);
    expect(submitted).toHaveLength(0);
  }, 30_000);
});

describe('operations.send never serialises a name', () => {
  it('refuses a .obs recipient before reading the chain or signing', async () => {
    const calls: string[] = [];
    const client = new Proxy({}, { get: (_t, prop) => async () => { calls.push(String(prop)); return {}; } }) as unknown as ObsidianClient;
    const wallet = await Wallet.create('obs', PASSPHRASE);
    for (const to of ['obsidian.obs', ' Obsidian.OBS ']) {
      await expect(operations.send(client, wallet, { to, amountObs: '1' })).rejects.toThrow(/resolved to an address/);
    }
    expect(calls).toEqual([]);
  }, 30_000);
});
