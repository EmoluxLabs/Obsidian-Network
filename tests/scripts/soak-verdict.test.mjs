/**
 * Soak verdict rules.
 *
 *   node --test tests/scripts/soak-verdict.test.mjs
 *
 * A soak exists to catch the slow failures — memory that only grows, a chain
 * that quietly stops, an invariant that flips. It used to print PASS while
 * measuring nothing at all: with no `--pid`, every RSS sample was `NaN`, the
 * growth fell back to `0`, and the memory check silently never ran. These tests
 * pin the rule that a run which could not measure memory is a failure, not a
 * pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdict } from '../../scripts/soak-verdict.mjs';

const sample = (overrides = {}) => ({
  elapsed_s: 0, height: 100, peers: 1, mempool: 0, supply_obs: 0, invariant_ok: 1, syncing: 0, uptime_s: 60, rss_kb: 80_000,
  ...overrides,
});

const healthy = [
  sample({ elapsed_s: 0 }),
  sample({ elapsed_s: 30, height: 106, uptime_s: 90 }),
  sample({ elapsed_s: 60, height: 112, uptime_s: 120, rss_kb: 82_000 }),
  sample({ elapsed_s: 90, height: 118, uptime_s: 150, rss_kb: 84_000 }),
];

test('a healthy run passes, and reports the growth it measured', () => {
  const result = verdict(healthy, { maxGrowthPct: 25, skipMemory: false });
  assert.deepEqual(result.problems, []);
  assert.equal(result.memoryMeasured, true);
  assert.equal(result.blocks, 18);
  assert.ok(result.growth > 0 && result.growth < 25);
});

test('an unmeasurable memory check is a failure, never a silent pass', () => {
  const noRss = healthy.map((row) => ({ ...row, rss_kb: NaN }));
  const result = verdict(noRss, { maxGrowthPct: 25, skipMemory: false });
  assert.equal(result.memoryMeasured, false);
  assert.equal(result.growth, null);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /memory was not measured/);
});

test('--skip-memory says the check did not run instead of pretending it passed', () => {
  const noRss = healthy.map((row) => ({ ...row, rss_kb: NaN }));
  const result = verdict(noRss, { maxGrowthPct: 25, skipMemory: true });
  assert.deepEqual(result.problems, []);
  assert.equal(result.memoryMeasured, false);
  assert.equal(result.growth, null);
});

test('growth past the limit fails, and a zero-byte reading is not a measurement', () => {
  const leaked = [
    sample({ elapsed_s: 0, height: 100 }),
    sample({ elapsed_s: 30, height: 106 }),
    sample({ elapsed_s: 60, height: 112, rss_kb: 80_000 }),
    sample({ elapsed_s: 90, height: 118, rss_kb: 140_000 }),
  ];
  const grown = verdict(leaked, { maxGrowthPct: 25, skipMemory: false });
  assert.deepEqual(grown.problems, ['RSS grew 75.0% in the second half (limit 25%)']);

  // `0` is what a missing /proc reading looked like after `?? 0`; it is not a
  // measurement, and must not be treated as one.
  const zeroed = healthy.map((row) => ({ ...row, rss_kb: 0 }));
  assert.equal(verdict(zeroed, { maxGrowthPct: 25, skipMemory: false }).memoryMeasured, false);
});

test('a stalled chain and a broken invariant are both reported', () => {
  const stalled = healthy.map((row) => ({ ...row, height: 100 }));
  assert.match(verdict(stalled, { maxGrowthPct: 25, skipMemory: true }).problems.join(' '), /did not advance/);

  const broken = healthy.map((row, index) => ({ ...row, invariant_ok: index === 2 ? 0 : 1 }));
  assert.match(verdict(broken, { maxGrowthPct: 25, skipMemory: true }).problems.join(' '), /supply invariant was false/);
});
