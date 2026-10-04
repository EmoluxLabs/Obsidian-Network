/**
 * The soak verdict, as a pure function.
 *
 * It lives in its own file so it can be tested without running a soak: the rule
 * that matters most is a negative one. A run that could not measure memory must
 * not report PASS. The previous version sampled `NaN` for RSS, treated the
 * growth as `0`, and printed a green verdict over a check that never ran — in a
 * script whose whole purpose is catching memory that only grows.
 */
export function verdict(rows, { maxGrowthPct, skipMemory }) {
  const first = rows[0];
  const last = rows[rows.length - 1];
  const half = rows.slice(Math.floor(rows.length / 2));
  const rssStart = half[0].rss_kb;
  const rssEnd = last.rss_kb;
  const memoryMeasured = Number.isFinite(rssStart) && rssStart > 0 && Number.isFinite(rssEnd);
  const growth = memoryMeasured ? ((rssEnd - rssStart) / rssStart) * 100 : null;
  const blocks = last.height - first.height;
  const minutes = (last.elapsed_s - first.elapsed_s) / 60;
  const invariantHeld = rows.every((row) => row.invariant_ok === 1);
  const stalled = blocks <= 0;
  const problems = [];
  if (stalled) problems.push('the chain did not advance');
  if (!invariantHeld) problems.push('the supply invariant was false in at least one sample');
  if (!memoryMeasured && !skipMemory) {
    problems.push('memory was not measured: pass --match "dist/index.js start" or --pid <node pid>, or opt out with --skip-memory');
  } else if (memoryMeasured && growth > maxGrowthPct) {
    problems.push(`RSS grew ${growth.toFixed(1)}% in the second half (limit ${maxGrowthPct}%)`);
  }
  return { rssStart, rssEnd, memoryMeasured, growth, blocks, minutes, invariantHeld, stalled, problems };
}
