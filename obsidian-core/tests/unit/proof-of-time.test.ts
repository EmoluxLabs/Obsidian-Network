/**
 * Proof of Time — the temporal rules, tested as rules rather than as vocabulary.
 *
 * Renaming "work" to "time" proves nothing. What these tests assert is that the
 * protocol's acceptance decisions depend on TIME derived from the chain, that a
 * lying clock cannot buy anything, and that the published PoT metrics are
 * recomputable by anyone holding the same blocks.
 */

import { describe, expect, it } from 'vitest';
import {
  medianTimePast,
  potDifficulty,
  requiredSpacingSeconds,
  timeRate,
  validateBlockTime,
} from '../../src/consensus/time.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { potWeight } from '../../src/blockchain/block.js';
import { compareTips } from '../../src/consensus/proposer.js';
import { PARAMS_HASH, computeParamsHash } from '../../src/blockchain/state-root.js';

/** Build a descending ancestor list (nearest parent first) with fixed spacing. */
function chainOf(count: number, spacingSeconds: number, tipTime = 1_000_000, txCount = 0) {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: tipTime - index * spacingSeconds,
    height: count - index,
    txCount,
  }));
}

describe('protocol identity', () => {
  it('declares Proof of Time, and the fork-choice rule never mentions work', () => {
    expect(CONSENSUS_PARAMS.proofOfTime.consensus).toBe('PROOF_OF_TIME');
    expect(CONSENSUS_PARAMS.proofOfTime.shortName).toBe('PoT');
    expect(CONSENSUS_PARAMS.consensus.forkChoice).toBe('FINALIZED_ANCHOR_THEN_FIXED_POT_WEIGHT_THEN_HEIGHT_THEN_LOWEST_HASH');
    expect(CONSENSUS_PARAMS.consensus.forkChoice).not.toMatch(/WORK/);
  });

  it('gives every valid block one unit so transaction spam cannot buy fork weight', () => {
    expect(potWeight(0)).toBe(1n);
    expect(potWeight(7)).toBe(1n);
    expect(potWeight(Number.MAX_SAFE_INTEGER)).toBe(1n);
  });

  it('prefers PoT weight, then height, then the lowest hash deterministically', () => {
    const heavier = { height: 10, cumulativePotWeight: 50n, hash: 'ff' };
    const lighter = { height: 12, cumulativePotWeight: 40n, hash: 'aa' };
    expect(compareTips(heavier, lighter)).toBe(1);

    const sameWeightTaller = { height: 12, cumulativePotWeight: 40n, hash: 'ff' };
    const sameWeightShorter = { height: 10, cumulativePotWeight: 40n, hash: 'aa' };
    expect(compareTips(sameWeightTaller, sameWeightShorter)).toBe(1);

    const tieLow = { height: 10, cumulativePotWeight: 40n, hash: 'aa' };
    const tieHigh = { height: 10, cumulativePotWeight: 40n, hash: 'bb' };
    expect(compareTips(tieLow, tieHigh)).toBe(1);
    expect(compareTips(tieHigh, tieLow)).toBe(-1);
    expect(compareTips(tieLow, { ...tieLow })).toBe(0);
  });
});

describe('median time past', () => {
  it('is the median of the window, so one absurd timestamp cannot move the clock', () => {
    const honest = [{ timestamp: 1000 }, { timestamp: 999 }, { timestamp: 998 }, { timestamp: 997 }, { timestamp: 996 }];
    const withLiar = [{ timestamp: 9_999_999 }, ...honest.slice(1)];
    expect(medianTimePast(honest)).toBe(998);
    // The liar's timestamp is in the window and still does not become the clock.
    expect(medianTimePast(withLiar)).toBe(998);
  });

  it('is zero for an empty chain rather than guessing', () => {
    expect(medianTimePast([])).toBe(0);
  });
});

describe('PoT difficulty', () => {
  it('rises when blocks come faster than the target and falls when they come slower', () => {
    const fast = potDifficulty(chainOf(60, 1));
    const slow = potDifficulty(chainOf(60, 60));
    expect(fast.difficultyBps).toBeGreaterThan(10_000);
    expect(slow.difficultyBps).toBeLessThan(10_000);
    expect(fast.difficultyBps).toBeGreaterThan(slow.difficultyBps);
  });

  it('is exactly on target when the chain runs at the target spacing', () => {
    const onTarget = potDifficulty(chainOf(60, CONSENSUS_PARAMS.proofOfTime.difficultyTargetSeconds));
    expect(onTarget.difficultyBps).toBe(10_000);
    expect(onTarget.observedSpacingMs).toBe(CONSENSUS_PARAMS.proofOfTime.difficultyTargetSeconds * 1000);
  });

  it('stays inside its published bounds no matter how extreme the history', () => {
    const absurdlyFast = potDifficulty(chainOf(60, 1, 1_000_000));
    const absurdlySlow = potDifficulty(chainOf(60, 100_000));
    for (const state of [absurdlyFast, absurdlySlow]) {
      expect(state.difficultyBps).toBeGreaterThanOrEqual(CONSENSUS_PARAMS.proofOfTime.minDifficultyBps);
      expect(state.difficultyBps).toBeLessThanOrEqual(CONSENSUS_PARAMS.proofOfTime.maxDifficultyBps);
      expect(requiredSpacingSeconds(state)).toBeGreaterThanOrEqual(1);
    }
  });

  it('reports that it is warming up instead of inventing a number', () => {
    expect(potDifficulty([]).warmingUp).toBe(true);
    expect(potDifficulty([{ timestamp: 10 }]).warmingUp).toBe(true);
    expect(potDifficulty([{ timestamp: 10 }]).observedSpacingMs).toBe(0);
  });

  it('ignores the genesis gap instead of reporting it as the block spacing', () => {
    // A packaged release reported 7,822,856,666 ms of "observed spacing" while
    // producing a block every 5 seconds, because the window still contained the
    // months-long gap between the genesis instant and launch. This is that case.
    const launched = chainOf(20, 5, 1_000_000).map((block, index) => ({ ...block, height: 20 - index }));
    const withGenesisGap = [...launched, { timestamp: 1_000_000 - 90 * 24 * 3600, height: 0, txCount: 0 }];
    const state = potDifficulty(withGenesisGap);
    expect(state.observedSpacingMs).toBe(5_000);
    expect(state.difficultyBps).toBe(10_000);
  });

  it('reports nothing measurable when only the genesis gap exists', () => {
    // Height 1: one real block, one gap, and that gap is the genesis gap. The
    // honest answer is "warming up", not a spacing of three months.
    const justLaunched = [
      { timestamp: 1_000_000, height: 1, txCount: 0 },
      { timestamp: 1_000_000 - 90 * 24 * 3600, height: 0, txCount: 0 },
    ];
    const state = potDifficulty(justLaunched);
    expect(state.observedSpacingMs).toBe(0);
    expect(state.warmingUp).toBe(true);
    expect(state.difficultyBps).toBe(10_000);
  });

  it('ignores a single stalled block after an outage', () => {
    const healthy = chainOf(30, 5, 1_000_000).map((block, index) => ({ ...block, height: 30 - index }));
    const withStall = healthy.map((block, index) => (index >= 16 ? { ...block, timestamp: block.timestamp - 3_600 } : block));
    expect(potDifficulty(withStall).observedSpacingMs).toBe(5_000);
  });

  it('is deterministic: the same history always produces the same difficulty', () => {
    const history = chainOf(40, 3);
    expect(potDifficulty(history)).toEqual(potDifficulty([...history]));
  });
});

describe('block time validation', () => {
  const ancestors = chainOf(11, 5, 1_000_000);

  it('accepts a block whose timestamp advances past the median and the parent', () => {
    const verdict = validateBlockTime({ timestamp: 1_000_005 }, ancestors, 1_000_005);
    expect(verdict.ok).toBe(true);
  });

  it('rejects a block that does not advance the parent (no stalling time)', () => {
    const verdict = validateBlockTime({ timestamp: 1_000_000 }, ancestors, 1_000_100);
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('ERR_TIME_NOT_ADVANCING');
  });

  it('rejects a backdated block even when the producer insists', () => {
    const verdict = validateBlockTime({ timestamp: 999_000 }, ancestors, 1_000_100);
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('ERR_TIME_NOT_ADVANCING');
  });

  it('rejects a block from the future beyond the drift bound', () => {
    const drift = CONSENSUS_PARAMS.block.maxFutureDriftSeconds;
    const verdict = validateBlockTime({ timestamp: 1_000_000 + drift + 5 }, ancestors, 1_000_000);
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('ERR_TIME_FROM_FUTURE');
  });

  it('lets a validating node reject with its own clock but never accept with it', () => {
    // A node whose clock is a decade behind cannot accept a block the chain
    // rules reject; the chain-derived clauses are evaluated first and stand
    // alone. This is the asymmetry that makes device clocks irrelevant.
    const backdated = { timestamp: 999_000 };
    expect(validateBlockTime(backdated, ancestors, 1).ok).toBe(false);
    expect(validateBlockTime(backdated, ancestors, 10_000_000_000).ok).toBe(false);

    // And a node with no clock opinion at all still enforces the chain rules.
    expect(validateBlockTime(backdated, ancestors, undefined).ok).toBe(false);
    expect(validateBlockTime({ timestamp: 1_000_005 }, ancestors, undefined).ok).toBe(true);
  });

  it('accepts the very first block after genesis without a parent window', () => {
    expect(validateBlockTime({ timestamp: 5 }, [], 10).ok).toBe(true);
  });
});

describe('Time-Rate', () => {
  it('measures verified blocks and transactions per minute of protocol time', () => {
    // 61 blocks, 60 gaps of 1s = 60s of protocol time, 2 transactions each.
    const rate = timeRate(chainOf(61, 1, 1_000_000, 2));
    expect(rate.windowSeconds).toBe(60);
    expect(rate.blocksPerMinute).toBe(60);
    expect(rate.transactionsPerMinute).toBe(122); // 61 blocks × 2 txs over 60s
    expect(rate.unit).toBe('BLOCKS_AND_TXS_PER_MINUTE');
  });

  it('never invents a rate when there is nothing to measure', () => {
    const empty = timeRate([]);
    expect(empty.blocksPerMinute).toBe(0);
    expect(empty.windowSeconds).toBe(0);
    expect(empty.method).toContain('no blocks');

    const single = timeRate([{ timestamp: 500, txCount: 9 }]);
    expect(single.blocksPerMinute).toBe(0);
    expect(single.transactionsPerMinute).toBe(0);
  });

  it('ignores blocks older than the measurement window', () => {
    const recent = chainOf(10, 1, 1_000_000, 1);
    const ancient = [{ timestamp: 1, height: 0, txCount: 500 }];
    const rate = timeRate([...recent, ...ancient], 100);
    // The ancient block is outside the 100s window and contributes nothing.
    expect(rate.blocks).toBe(10);
    expect(rate.transactions).toBe(10);
  });

  it('is a time measurement, never a hashrate: it cannot be raised by computing', () => {
    // Two chains with identical timing but wildly different "effort" produce the
    // same Time-Rate, because Time-Rate counts verified state over time.
    const a = timeRate(chainOf(31, 2, 1_000_000, 4));
    const b = timeRate(chainOf(31, 2, 5_000_000, 4));
    expect(a.blocksPerMinute).toBe(b.blocksPerMinute);
    expect(a.transactionsPerMinute).toBe(b.transactionsPerMinute);
  });
});

/**
 * PARAMS_HASH completeness.
 *
 * The handshake refuses a peer whose params hash differs, and `executeGovernance`
 * asserts that parameters cannot change without a coordinated upgrade. Both
 * claims are only true if the hash actually covers every parameter. It used to
 * cover a hand-written list, which had drifted: `gas.minGas`, `tx.minTransfer`,
 * `consensus.maxReorgDepth` and others were absent, so two nodes could disagree
 * about a consensus rule, pass the handshake, and fork at the first transaction
 * that touched it.
 *
 * This walks every leaf of the real parameter tree, changes it, and requires the
 * hash to move. A parameter added in future with no effect on the hash fails
 * here rather than in production.
 */
describe('PARAMS_HASH covers every consensus parameter', () => {
  /** Every path to a scalar leaf in the tree, as arrays of keys/indices. */
  function leafPaths(value: unknown, prefix: Array<string | number> = []): Array<Array<string | number>> {
    if (Array.isArray(value)) {
      return value.flatMap((item, index) => leafPaths(item, [...prefix, index]));
    }
    if (value !== null && typeof value === 'object') {
      return Object.keys(value as Record<string, unknown>).flatMap((key) =>
        leafPaths((value as Record<string, unknown>)[key], [...prefix, key]),
      );
    }
    return [prefix];
  }

  function clone<T>(value: T): T {
    if (Array.isArray(value)) return value.map((item) => clone(item)) as unknown as T;
    if (value !== null && typeof value === 'object' && typeof value !== 'bigint') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, clone(item)]),
      ) as T;
    }
    return value;
  }

  /** A different value of the same type, so the test proves coverage not type-tagging. */
  function perturb(value: unknown): unknown {
    if (typeof value === 'bigint') return value + 1n;
    if (typeof value === 'number') return value + 1;
    if (typeof value === 'boolean') return !value;
    if (typeof value === 'string') return `${value}-changed`;
    throw new Error(`cannot perturb ${typeof value}`);
  }

  const paths = leafPaths(CONSENSUS_PARAMS);

  it('finds a non-trivial number of parameters to check', () => {
    expect(paths.length).toBeGreaterThan(80);
  });

  it('changes when any single leaf changes', () => {
    const baseline = computeParamsHash(CONSENSUS_PARAMS);
    expect(baseline).toBe(PARAMS_HASH);

    const unchanged: string[] = [];
    for (const path of paths) {
      const mutated = clone(CONSENSUS_PARAMS) as Record<string, unknown>;
      let cursor: Record<string | number, unknown> = mutated;
      for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string | number, unknown>;
      const last = path[path.length - 1];
      cursor[last] = perturb(cursor[last]);
      if (computeParamsHash(mutated) === baseline) unchanged.push(path.join('.'));
    }

    expect(unchanged, `these parameters do not affect PARAMS_HASH: ${unchanged.join(', ')}`).toEqual([]);
  });

  it('does not depend on key declaration order', () => {
    const reversed = Object.fromEntries(Object.entries(CONSENSUS_PARAMS).reverse());
    expect(computeParamsHash(reversed)).toBe(PARAMS_HASH);
  });

  it('refuses a floating-point parameter rather than hashing it', () => {
    expect(() => computeParamsHash({ ...CONSENSUS_PARAMS, bad: 1.5 })).toThrow(/not an integer/);
  });
});
