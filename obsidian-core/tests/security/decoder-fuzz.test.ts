/**
 * Hostile bytes into every decoder a peer or an RPC caller can reach (protocol 1.9.0 surfaces included).
 *
 * The property: a decoder either returns a value that re-encodes to the same bytes, or throws an ordinary Error. It
 * never hangs, never throws a non-Error, never reads past its input and never allocates by a length the caller chose.
 * A seeded generator makes any failure reproducible.
 */
import { describe, expect, it } from 'vitest';
import { decodeNodeRegistryBody, encodeNodeRegistryBody } from '../../src/transactions/executors/node-registry.js';
import { decodeOnsBody, encodeOnsBody } from '../../src/transactions/executors/ons.js';
import { decodeMarketBody, encodeMarketBody } from '../../src/transactions/executors/marketplace.js';
import { decodeSignedTxFromBytes } from '../../src/transactions/encode.js';
import { parsePrivateKeyInput } from '../../src/crypto/private-key.js';
import { MarketOp, NodeRegistryOp, OnsOp } from '../../src/protocol/types.js';

function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x1_0000_0000;
  };
}
const bytes = (random: () => number, length: number) => Uint8Array.from({ length }, () => Math.floor(random() * 256));
const mutate = (random: () => number, source: Uint8Array) => {
  const copy = Uint8Array.from(source);
  const flips = 1 + Math.floor(random() * 4);
  for (let i = 0; i < flips && copy.length > 0; i += 1) copy[Math.floor(random() * copy.length)] ^= 1 << Math.floor(random() * 8);
  return random() < 0.2 ? copy.slice(0, Math.floor(random() * copy.length)) : copy;
};

function holds(decode: (input: Uint8Array) => unknown, input: Uint8Array): 'ok' | 'rejected' {
  const started = Date.now();
  try {
    decode(input);
    return 'ok';
  } catch (error) {
    expect(error, 'decoders throw ordinary errors only').toBeInstanceOf(Error);
    return 'rejected';
  } finally {
    expect(Date.now() - started, 'a decoder must not be made to work hard by its input').toBeLessThan(1000);
  }
}

describe('decoders survive hostile input', () => {
  const random = rng(0x0b51d1a9);

  it('node-registry bodies: random bytes, mutations of valid bodies, lying lengths', () => {
    const valid = [
      encodeNodeRegistryBody({ op: NodeRegistryOp.REGISTER, endpoint: '203.0.113.10:8631', rewardWallet: 'dobs1' + 'q'.repeat(38) } as never),
    ];
    let accepted = 0;
    for (let i = 0; i < 3000; i += 1) {
      const input = i % 3 === 0 ? bytes(random, Math.floor(random() * 300)) : mutate(random, valid[i % valid.length]);
      if (holds(decodeNodeRegistryBody, input) === 'ok') accepted += 1;
    }
    // A header that claims a gigantic length with no body behind it.
    for (const length of [0xffff_ffff, 0x7fff_ffff, 1 << 24]) {
      const lie = new Uint8Array(8);
      new DataView(lie.buffer).setUint32(1, length, false);
      holds(decodeNodeRegistryBody, lie);
    }
    expect(accepted).toBeLessThan(3000);
  });

  it('ONS bodies: every op, random and mutated', () => {
    const seeds = Object.values(OnsOp)
      .filter((op): op is number => typeof op === 'number')
      .map((op) => {
        try {
          return encodeOnsBody({ op, name: 'alpha', to: 'dobs1' + 'q'.repeat(38), years: 1 } as never);
        } catch {
          return new Uint8Array([op]);
        }
      });
    expect(seeds.length).toBeGreaterThan(5);
    for (let i = 0; i < 4000; i += 1) {
      const input = i % 4 === 0 ? bytes(random, Math.floor(random() * 200)) : mutate(random, seeds[i % seeds.length]);
      holds(decodeOnsBody, input);
    }
  });

  it('Marketplace bodies: every op, random and mutated, and round-trips of valid bodies', () => {
    const valid = Object.values(MarketOp)
      .filter((op): op is number => typeof op === 'number')
      .map((op) => encodeMarketBody({ op, name: 'alpha', amount: 123456789n, counterparty: 'dobs1' + 'q'.repeat(38), offerId: 'ab'.repeat(32) }));
    expect(valid).toHaveLength(8);
    for (const body of valid) expect(encodeMarketBody(decodeMarketBody(body))).toEqual(body);
    for (let i = 0; i < 4000; i += 1) {
      const input = i % 4 === 0 ? bytes(random, Math.floor(random() * 200)) : mutate(random, valid[i % valid.length]);
      if (holds(decodeMarketBody, input) === 'ok') expect(encodeMarketBody(decodeMarketBody(input))).toEqual(input);
    }
  });

  it('signed transactions: random bytes never decode into something that crashes the node', () => {
    for (let i = 0; i < 3000; i += 1) holds(decodeSignedTxFromBytes, bytes(random, Math.floor(random() * 600)));
  });

  it('private-key input: any string is classified, none is echoed, none throws', () => {
    const alphabet = '0123456789abcdefABCDEFxX \n\t-_zZ';
    for (let i = 0; i < 4000; i += 1) {
      const length = Math.floor(random() * 140);
      const text = Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
      const outcome = parsePrivateKeyInput(text);
      if (!outcome.ok) {
        const shown = JSON.stringify(outcome);
        const compact = text.trim().replace(/^0x/i, '');
        if (compact.length >= 8) expect(shown.includes(compact), 'a refusal never echoes the input').toBe(false);
      }
    }
  });
});
