import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MEMPOOL_OPTIONS, Mempool } from '../../src/blockchain/mempool.js';
import { TxType } from '../../src/protocol/types.js';
import { encodeSignedTx } from '../../src/transactions/encode.js';
import { createHarness, makeWallet, type Harness } from '../helpers/harness.js';

const open: Harness[] = [];
afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

async function transactions(gases: bigint[]) {
  const h = await createHarness();
  open.push(h);
  return gases.map((gas, index) => {
    const wallet = makeWallet();
    return h.sign(wallet, TxType.GOVERNANCE, new Uint8Array([index + 1]), {
      gas,
      nonce: 0,
      protocolTime: h.chain.protocolTime,
    });
  });
}

describe('mempool displacement resistance', () => {
  it('does not let lower or equal gas arrivals displace paid first-seen work', async () => {
    const [paid, free, equal] = await transactions([10n, 0n, 10n]);
    const pool = new Mempool({ ...DEFAULT_MEMPOOL_OPTIONS, maxTransactions: 1, maxBytes: 1_000_000, maxPerSender: 4 });
    expect(pool.add(paid).accepted).toBe(true);
    expect(pool.add(free).accepted).toBe(false);
    expect(pool.add(equal).accepted).toBe(false);
    expect(pool.has(paid.id)).toBe(true);
    expect(pool.size).toBe(1);
  });

  it('allows strictly higher-priority work to replace lower-priority work', async () => {
    const [low, high] = await transactions([1n, 2n]);
    const pool = new Mempool({ ...DEFAULT_MEMPOOL_OPTIONS, maxTransactions: 1, maxBytes: 1_000_000, maxPerSender: 4 });
    expect(pool.add(low).accepted).toBe(true);
    expect(pool.add(high).accepted).toBe(true);
    expect(pool.has(low.id)).toBe(false);
    expect(pool.has(high.id)).toBe(true);
  });

  it('plans byte-budget eviction atomically when lower-gas removals still cannot make room', async () => {
    const h = await createHarness();
    open.push(h);
    const lowWallet = makeWallet();
    const protectedWallet = makeWallet();
    const incomingWallet = makeWallet();
    const low = h.sign(lowWallet, TxType.GOVERNANCE, new Uint8Array(1), { gas: 1n });
    const protectedTx = h.sign(protectedWallet, TxType.GOVERNANCE, new Uint8Array(600), { gas: 10n });
    const incoming = h.sign(incomingWallet, TxType.GOVERNANCE, new Uint8Array(600), { gas: 5n });
    const budget = encodeSignedTx(low).length + encodeSignedTx(protectedTx).length;
    expect(encodeSignedTx(incoming).length).toBeLessThan(budget);

    const pool = new Mempool({ ...DEFAULT_MEMPOOL_OPTIONS, maxTransactions: 3, maxBytes: budget, maxPerSender: 4 });
    expect(pool.add(low).accepted).toBe(true);
    expect(pool.add(protectedTx).accepted).toBe(true);
    expect(pool.add(incoming).accepted).toBe(false);
    expect(pool.has(low.id)).toBe(true);
    expect(pool.has(protectedTx.id)).toBe(true);
    expect(pool.size).toBe(2);
  });
});
