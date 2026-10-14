/**
 * Recipient resolution: a `.obs` name becomes a validated native address, or nothing.
 *
 * The node is mocked — no mainnet state, no real funds. The mock answers exactly what
 * `GET /names/:name` and `/status` answer, including its 404 shape, so each failure class
 * is the one a live node would produce.
 */
import { describe, expect, it } from 'vitest';

import { addressFromPublicKey, generateKeyPair } from '../../src/crypto/keys.js';
import {
  failureMessage,
  parseOnsName,
  reconfirmOnsName,
  recipientKind,
  resolveOnsName,
  type ResolveDeps,
} from '../../src/protocol/recipient.js';

const NOW = 1_800_000_000;
const MAINNET = { chainId: 7777, addressHrp: 'obs' };

const addressOn = (hrp: string) => generateKeyPair(hrp).address;
const OWNER = addressOn('obs');
const TARGET = addressOn('obs');

const record = (over: Record<string, unknown> = {}) => ({
  name: 'obsidian.obs',
  owner: OWNER,
  address: TARGET,
  registeredAt: NOW - 1000,
  registeredAtHeight: 5,
  expiresAt: NOW + 31_536_000,
  transferCount: 0,
  resolved: true,
  ...over,
});

class NodeError extends Error {
  constructor(message: string, readonly status: number | null, readonly code: string | null) {
    super(message);
  }
}
const notRegistered = () => new NodeError('name not registered', 404, 'ERR_NOT_FOUND');

function deps(over: Partial<ResolveDeps> & { answer?: unknown; calls?: string[] } = {}): ResolveDeps {
  return {
    lookup: async (name) => {
      over.calls?.push(name);
      if ('answer' in over) {
        if (over.answer instanceof Error) throw over.answer;
        return over.answer;
      }
      return record();
    },
    context: async () => ({ ...MAINNET, protocolTime: NOW }),
    expected: async () => MAINNET,
    timeoutMs: 200,
    ...over,
  };
}

describe('recipientKind / parseOnsName', () => {
  it('separates names from addresses without ever calling a bare word a name', () => {
    expect(recipientKind('')).toBe('empty');
    expect(recipientKind('   ')).toBe('empty');
    expect(recipientKind(undefined)).toBe('empty');
    expect(recipientKind('obsidian.obs')).toBe('name');
    expect(recipientKind('  Obsidian.OBS ')).toBe('name');
    expect(recipientKind(OWNER)).toBe('address');
    expect(recipientKind('obsidian')).toBe('address');
    expect(recipientKind('obsidian.com')).toBe('address');
  });

  it('applies the ONS rules and normalises case and surrounding whitespace only', () => {
    expect(parseOnsName('  Obsidian.OBS ')).toBe('obsidian.obs');
    expect(parseOnsName('a-b-c.obs')).toBe('a-b-c.obs');
    expect(parseOnsName('x'.repeat(63) + '.obs')).toBe('x'.repeat(63) + '.obs');
    for (const bad of [
      'ab.obs', // too short
      `${'x'.repeat(64)}.obs`, // too long
      '-ab.obs',
      'ab-.obs',
      'a--b.obs',
      'foo bar.obs',
      'foo_bar.obs',
      'foo.bar.obs',
      'foo.obs.obs',
      '.obs',
      'foo@bar.obs',
      'foo/../bar.obs',
      'foo%2e.obs',
      'ｆｏｏ.obs',
      'fo\u0000o.obs',
      'obsidian.obs?x=1',
      'obsidian.obs#x',
      'obsidian.obs/',
      'obsidian.obsx',
      'obsidian.com',
    ]) {
      expect(parseOnsName(bad), bad).toBeNull();
    }
  });

  it('refuses a protocol-reserved name — it can never have been registered', () => {
    for (const reserved of ['admin.obs', 'treasury.obs', 'wallet.obs', 'obs.obs']) expect(parseOnsName(reserved), reserved).toBeNull();
    expect(parseOnsName('obsidian.obs')).toBe('obsidian.obs');
  });
});

describe('resolveOnsName', () => {
  it('resolves a registered name to the record address, for this network', async () => {
    const calls: string[] = [];
    const result = await resolveOnsName('  Obsidian.obs ', deps({ calls }));
    expect(result).toEqual({
      ok: true,
      name: 'obsidian.obs',
      address: TARGET,
      expiresAt: NOW + 31_536_000,
      network: MAINNET,
    });
    // The node is asked the normalised name — once.
    expect(calls).toEqual(['obsidian.obs']);
    // The target is the registered ADDRESS, not the owner.
    expect((result as { address: string }).address).not.toBe(OWNER);
  });

  it('never asks the node about a name the ONS rules refuse', async () => {
    const calls: string[] = [];
    for (const bad of ['foo bar.obs', 'ab.obs', 'a--b.obs', 'a.b.obs', 'foo.obs.obs']) {
      const result = await resolveOnsName(bad, deps({ calls }));
      expect(result).toMatchObject({ ok: false, code: 'NAME_INVALID' });
    }
    expect(calls).toEqual([]);
  });

  it('reports an unregistered name as exactly that', async () => {
    const result = await resolveOnsName('nobody.obs', deps({ answer: notRegistered() }));
    expect(result).toEqual({ ok: false, code: 'NAME_NOT_FOUND', message: 'ONS name not found on Mainnet.' });
  });

  it('does not read a route the node does not serve as "unregistered"', async () => {
    const result = await resolveOnsName('nobody.obs', deps({ answer: new NodeError('not found', 404, 'ERR_NOT_FOUND') }));
    expect(result).toMatchObject({ ok: false, code: 'LOOKUP_UNAVAILABLE' });
  });

  it('treats a transport error, a 5xx, a 400 and a bad gateway as unavailable — never as a verdict', async () => {
    for (const error of [
      new TypeError('fetch failed'),
      new NodeError('HTTP 502 from /api/rpc', 502, null),
      new NodeError('HTTP 500', 500, 'ERR_INTERNAL'),
      new NodeError('bad request', 400, 'ERR_REJECTED'),
      new NodeError('forbidden', 403, null),
    ]) {
      const result = await resolveOnsName('obsidian.obs', deps({ answer: error }));
      expect(result).toEqual({ ok: false, code: 'LOOKUP_UNAVAILABLE', message: 'Could not resolve this ONS name. Please try again.' });
    }
  });

  it('times out a lookup that never answers, with no fallback', async () => {
    const hang = () => new Promise<never>(() => undefined);
    expect(await resolveOnsName('obsidian.obs', deps({ lookup: hang, timeoutMs: 20 }))).toMatchObject({ code: 'LOOKUP_UNAVAILABLE' });
    expect(await resolveOnsName('obsidian.obs', deps({ context: hang, timeoutMs: 20 }))).toMatchObject({ code: 'LOOKUP_UNAVAILABLE' });
    expect(await resolveOnsName('obsidian.obs', deps({ expected: hang, timeoutMs: 20 }))).toMatchObject({ code: 'LOOKUP_UNAVAILABLE' });
  });

  it('does not resolve when the app cannot say which network it is', async () => {
    for (const expected of [
      async () => { throw new Error('config unreachable'); },
      async () => ({ chainId: Number.NaN, addressHrp: 'obs' }),
      async () => ({ chainId: 7777, addressHrp: '' }),
      async () => null as never,
    ]) {
      expect(await resolveOnsName('obsidian.obs', deps({ expected }))).toMatchObject({ ok: false, code: 'LOOKUP_UNAVAILABLE' });
    }
  });

  it('rejects an answer that is not a record for the name asked about', async () => {
    const wrong: unknown[] = [
      null,
      'obs1xyz',
      [],
      {},
      record({ name: 'someone-else.obs' }),
      record({ name: undefined }),
      record({ resolved: false }),
      record({ address: undefined }),
      record({ address: 42 }),
      record({ expiresAt: 'soon' }),
      record({ expiresAt: undefined }),
      record({ expiresAt: 1.5 }),
    ];
    for (const answer of wrong) {
      const result = await resolveOnsName('obsidian.obs', deps({ answer }));
      expect(result, JSON.stringify(answer)).toMatchObject({ ok: false, code: 'MALFORMED_RECORD' });
    }
  });

  it('rejects an address that is not valid for this network', async () => {
    const valid = addressOn('obs');
    const broken = valid.slice(0, -1) + (valid.endsWith('q') ? 'p' : 'q'); // checksum no longer matches
    for (const address of [
      '',
      'obsidian.obs',
      'obs1',
      'obs1notanaddress',
      broken,
      valid.toUpperCase(),
      ` ${valid}`,
      `${valid} `,
      `${valid}\n`,
      valid + 'q',
      'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
      `0x${'ab'.repeat(20)}`,
    ]) {
      const result = await resolveOnsName('obsidian.obs', deps({ answer: record({ address }) }));
      expect(result, address).toEqual({
        ok: false,
        code: 'INVALID_ADDRESS',
        message: 'ONS name resolved to an invalid OBS address. Transaction blocked.',
      });
    }
  });

  it('rejects a lookup from the wrong network, both by the node and by the record', async () => {
    // The node is a testnet node.
    const testnetNode = deps({ context: async () => ({ chainId: 7778, addressHrp: 'tobs', protocolTime: NOW }) });
    expect(await resolveOnsName('obsidian.obs', testnetNode)).toMatchObject({ ok: false, code: 'NETWORK_MISMATCH' });
    // Same prefix, different chain id.
    const otherChain = deps({ context: async () => ({ chainId: 9999, addressHrp: 'obs', protocolTime: NOW }) });
    expect(await resolveOnsName('obsidian.obs', otherChain)).toMatchObject({ ok: false, code: 'NETWORK_MISMATCH' });
    // The node says mainnet but the record holds a testnet address.
    for (const hrp of ['tobs', 'sobs', 'dobs']) {
      const result = await resolveOnsName('obsidian.obs', deps({ answer: record({ address: addressOn(hrp) }) }));
      expect(result, hrp).toMatchObject({ ok: false, code: 'NETWORK_MISMATCH' });
    }
    // And the reverse: a testnet app held against a mainnet node.
    const testnetApp = deps({ expected: async () => ({ chainId: 7778, addressHrp: 'tobs' }) });
    expect(await resolveOnsName('obsidian.obs', testnetApp)).toMatchObject({ ok: false, code: 'NETWORK_MISMATCH' });
  });

  it('refuses an expired name — the node does not, and anyone may re-register it', async () => {
    for (const expiresAt of [NOW, NOW - 1, 0]) {
      const result = await resolveOnsName('obsidian.obs', deps({ answer: record({ expiresAt }) }));
      expect(result, String(expiresAt)).toMatchObject({ ok: false, code: 'NAME_EXPIRED' });
    }
    expect(await resolveOnsName('obsidian.obs', deps({ answer: record({ expiresAt: NOW + 1 }) }))).toMatchObject({ ok: true });
  });

  it('will not judge expiry without the node clock', async () => {
    const noClock = deps({ context: async () => ({ ...MAINNET, protocolTime: Number.NaN }) });
    expect(await resolveOnsName('obsidian.obs', noClock)).toMatchObject({ ok: false, code: 'LOOKUP_UNAVAILABLE' });
  });

  it('keeps each failure on its own message — a failed lookup is never "invalid address"', async () => {
    const messages = new Set(
      (['NAME_NOT_FOUND', 'LOOKUP_UNAVAILABLE', 'INVALID_ADDRESS', 'NAME_INVALID', 'MALFORMED_RECORD', 'NETWORK_MISMATCH', 'NAME_EXPIRED'] as const).map((code) =>
        failureMessage(code),
      ),
    );
    expect(messages.size).toBe(7);
    expect(failureMessage('LOOKUP_UNAVAILABLE')).not.toMatch(/invalid/i);
    expect(failureMessage('NAME_NOT_FOUND')).not.toMatch(/invalid/i);
  });

  it('never echoes node-supplied text into a message', async () => {
    const hostile = new NodeError('<img src=x onerror=alert(1)>', 500, null);
    const result = await resolveOnsName('obsidian.obs', deps({ answer: hostile }));
    expect(JSON.stringify(result)).not.toContain('onerror');
  });

  it('resolves to an address a real key derives, byte for byte', async () => {
    const pair = generateKeyPair('obs');
    expect(addressFromPublicKey(pair.publicKey, 'obs')).toBe(pair.address);
    const result = await resolveOnsName('obsidian.obs', deps({ answer: record({ address: pair.address }) }));
    expect(result).toMatchObject({ ok: true, address: pair.address });
  });
});

describe('reconfirmOnsName', () => {
  it('passes when the record is unchanged', async () => {
    const first = await resolveOnsName('obsidian.obs', deps());
    if (!first.ok) throw new Error('setup');
    expect(await reconfirmOnsName(first, deps())).toMatchObject({ ok: true, address: first.address });
  });

  it('blocks when the name now points elsewhere, has lapsed, or can no longer be read', async () => {
    const first = await resolveOnsName('obsidian.obs', deps());
    if (!first.ok) throw new Error('setup');
    const moved = await reconfirmOnsName(first, deps({ answer: record({ address: addressOn('obs') }) }));
    expect(moved).toMatchObject({ ok: false });
    expect(moved.ok === false && moved.message).toMatch(/different address/);
    expect(await reconfirmOnsName(first, deps({ answer: record({ expiresAt: NOW - 5 }) }))).toMatchObject({ code: 'NAME_EXPIRED' });
    expect(await reconfirmOnsName(first, deps({ answer: notRegistered() }))).toMatchObject({ code: 'NAME_NOT_FOUND' });
    expect(await reconfirmOnsName(first, deps({ answer: new TypeError('fetch failed') }))).toMatchObject({ code: 'LOOKUP_UNAVAILABLE' });
  });
});
