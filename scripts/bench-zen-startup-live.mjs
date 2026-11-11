#!/usr/bin/env node
/** Same-backend Rex startup and seeded-session benchmark, without model calls.
 * Usage: scripts/bench-zen-startup.sh startup|seeded bare zen1 [zen2 ...]
 * zen1 and zen2 remain accepted legacy labels. Both measure this checkout's
 * zen.ts, not retired implementations. Use bare/off/zen for current variants.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { RexTestDriver } from './rex-test-driver.mjs';
import { candidate, cli, version, start, stop, inspect, alive } from './test-zen-extension-live.mjs';

const [mode, ...variants] = process.argv.slice(2);
assert(['startup', 'seeded'].includes(mode) && variants.length > 0,
  'Usage: bench-zen-startup.sh startup|seeded bare zen1 [zen2 ...]');
assert(new Set(variants).size === variants.length, 'Duplicate variants do not form independent samples');
for (const variant of variants) assert(['bare', 'off', 'zen', 'zen1', 'zen2'].includes(variant), `Unknown variant: ${variant}`);
const repeats = Number(process.env.REPEATS ?? 7);
assert(Number.isInteger(repeats) && repeats >= 7 && repeats <= 15, 'REPEATS must be 7 through 15');
assert(process.env.ZEN_E2E_LIVE !== '1' && process.env.ZEN_E2E_ALLOW_MODEL_CALL !== '1', 'Benchmark never runs live models');
const deadline = Date.now() + 12 * 60_000;
const report = { backend: 'RexTestDriver private Rex', pi: version, cli, candidate, mode, repeats, pane: '120x44',
  measurement: 'Rex target creation through stable captured Pi ready paint, includes creation/login startup and target registration overhead; excludes private server startup and seed creation',
  pollMs: 100, stability: 'two consecutive equal captures after real ready event and footer paint',
  comparison: 'Only variants measured in this Rex run. No old timing comparisons.',
  aliases: 'zen1 and zen2 both use current checkout zen.ts; neither measures a retired version',
  samples: [], summary: {} };
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), half = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
};
let driver, host, sequence = 0;
try {
  driver = await RexTestDriver.start({ deadlineMs: 13 * 60_000 });
  for (let round = 0; round < repeats; round++) {
    // Rotate the first variant each round. Fixed-order interleaving gives the
    // first variant all cold-start effects and hides systematic ordering noise.
    const offset = round % variants.length;
    const order = [...variants.slice(offset), ...variants.slice(0, offset)];
    for (let position = 0; position < order.length; position++) {
      const variant = order[position];
      host = await start(driver, { variant, mode, sequence: ++sequence, deadline });
      const viewport = inspect(driver, host);
      const isCompact = !['bare', 'off'].includes(variant);
      if (mode === 'seeded') {
        assert(viewport.includes('Hello! The listing worked'), 'Seeded text not rendered');
        if (isCompact) {
          assert.match(viewport, /\$ ls -la\s+✓/);
          assert.match(viewport, /\$ cat missing\.txt\s+✗ cat: missing\.txt: No such file or directory/);
          assert(!viewport.includes('ZENOUT-MARKER'), 'Compact output leaked');
        } else assert(viewport.includes('ZENOUT-MARKER'), 'Native output missing');
      }
      // Keep the original full transcript row measurement. Rex history includes
      // scrollback, unlike the current-viewport capture used for readiness.
      const transcript = driver.capture(host, { history: true });
      const rows = mode === 'seeded' ? transcript.split('\n').filter(line => line.trim() &&
        !/Could not restore model|tmux extended-keys|tokens/.test(line)).length : 0;
      assert(mode !== 'seeded' || rows > 0, 'Empty history row count');
      report.samples.push({ round: round + 1, position: position + 1, variant, ms: host.startupMs, rows });
      console.log(`SAMPLE ${round + 1}/${repeats} ${variant} ${host.startupMs.toFixed(0)}ms ${rows} rows`);
      if (process.env.KEEP === '1') {
        report.captures ??= [];
        report.captures.push({ round: round + 1, variant, viewport, transcript });
      }
      await stop(driver, host);
    }
  }
  for (const variant of variants) {
    const samples = report.samples.filter(sample => sample.variant === variant);
    assert.equal(samples.length, repeats, 'Timeout or failed trials must not disappear from statistics');
    const med = median(samples.map(sample => sample.ms));
    report.summary[variant] = { n: samples.length, medianMs: med,
      madMs: median(samples.map(sample => Math.abs(sample.ms - med))),
      ...(mode === 'seeded' ? { medianRows: median(samples.map(sample => sample.rows)) } : {}) };
  }
} finally {
  if (driver) {
    const root = driver.root;
    const cleanup = await driver.stop();
    assert(cleanup?.clean && !existsSync(root), 'Private Rex cleanup unresolved');
    if (host?.pid) assert(!alive(host.pid), 'Pi survives benchmark cleanup');
    report.cleanup = cleanup.clean;
  }
  // KEEP retains only benchmark artifacts, not an active server or HOME. All
  // configs and sessions remain in the driver root and are always removed.
  if (process.env.KEEP === '1') {
    const artifacts = mkdtempSync('/tmp/zen-benchmark-report-');
    writeFileSync(`${artifacts}/report.json`, JSON.stringify(report, null, 2) + '\n');
    console.log(`KEEP: ${artifacts}/report.json`);
  }
}
console.log(`Zen benchmark: ${mode}, ${repeats} rotated repeats, same Rex backend, Pi ${version}`);
console.log(report.measurement);
console.log(report.comparison);
if (variants.some(variant => ['zen1', 'zen2'].includes(variant))) console.log(report.aliases);
for (const [variant, stats] of Object.entries(report.summary)) {
  console.log(`${variant}: ${stats.medianMs.toFixed(0)}ms (MAD ${stats.madMs.toFixed(0)}, n=${stats.n})` +
    (mode === 'seeded' ? `, median ${stats.medianRows} history rows` : ''));
}
console.log(`REPORT ${JSON.stringify({ ...report, captures: undefined })}`);
