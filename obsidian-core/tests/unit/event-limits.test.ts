import { afterEach, describe, expect, it } from 'vitest';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { ErrCode } from '../../src/protocol/errors.js';
import { createHarness, makeWallet, signedClaim, type Harness } from '../helpers/harness.js';

const open: Harness[] = [];
afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

describe('per-transaction event resource ceiling', () => {
  it('rejects a transaction as soon as its emitted events exceed the consensus limit', async () => {
    const h = await createHarness();
    open.push(h);
    const miner = makeWallet();
    const params = CONSENSUS_PARAMS.tx as { maxEventsPerTx: number };
    const configured = params.maxEventsPerTx;
    try {
      // Lowering the ceiling in-process makes an existing one-event executor an
      // adversarial vector for the generic guard without adding a test-only
      // transaction type to consensus code.
      params.maxEventsPerTx = 0;
      const outcome = h.tryBlock([signedClaim(h, miner, h.chain.protocolTime)]);
      expect(outcome.accepted).toBe(false);
      expect(outcome.code).toBe(ErrCode.BLOCK_TOO_LARGE);
      expect(outcome.message).toMatch(/emitted .* events; limit is 0/);
    } finally {
      params.maxEventsPerTx = configured;
    }
  });
});
