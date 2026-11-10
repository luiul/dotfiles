#!/usr/bin/env node
/** Alternating native/baseline/candidate render benchmarks in Pi's Node runtime. */
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { candidate, loadExtension, fixtures, fence, markdown, themeModule, version, repo } from './fixtures/code-blocks-runtime.mjs';
themeModule.initTheme('dark');
const baselinePath = process.env.CODEBLOCK_BENCH_BASELINE;
const baseline = baselinePath ? await loadExtension(baselinePath) : undefined;
const variants = [{ id: 'native' }, ...(baseline ? [{ id: 'baseline', extension: baseline }] : []), { id: 'candidate', extension: candidate }];
const large = Array.from({ length: 160 }, (_, i) => `const item${i}: string = "fixture value ${i}";`).join('\n');
const samples = { prose: 'Normal prose with **bold**, `inline code`, and a link https://pi.dev.\n'.repeat(20), small: fixtures.small, large: fence('typescript', large), mermaid: fixtures.mermaid };
const results = [];
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const trials = Number(process.env.CODEBLOCK_BENCH_TRIALS ?? 9);
const iterations = Number(process.env.CODEBLOCK_BENCH_ITERATIONS ?? 250);
for (let trial = 0; trial < trials; trial++) {
  for (const [fixture, source] of Object.entries(samples)) {
    for (const phase of ['cached', 'resize', 'first-paint', 'streaming', 'growing-code']) {
      const order = variants.slice(trial % variants.length).concat(variants.slice(0, trial % variants.length));
      for (const variant of order) {
        const installed = variant.extension?.installCodeFrames();
        if (variant.extension === baseline && installed) installed.patch.theme = themeModule.theme;
        const make = text => markdown(text, installed?.patch, { mermaid: true, extension: variant.extension });
        const component = make(source);
        component.render(96);
        let rows = 0;
        const run = i => {
          if (phase === 'first-paint') { rows = make(source).render(96).length; return; }
          if (phase === 'streaming') component.setText(source + '\n\nStreaming paragraph ' + (i % 2));
          if (phase === 'growing-code') component.setText(fence('typescript', (fixture === 'large' ? large : 'const answer = 42;') + '\nconst partial = ' + (i % 2)));
          rows = component.render(phase === 'resize' ? (i % 2 ? 60 : 96) : 96).length;
        };
        try {
          for (let i = 0; i < 50; i++) run(i);
          const cpu0 = process.cpuUsage();
          const start = performance.now();
          for (let i = 0; i < iterations; i++) run(i);
          const elapsed = performance.now() - start;
          const cpu = process.cpuUsage(cpu0);
          results.push({ trial, fixture, phase, variant: variant.id, microseconds: elapsed * 1000 / iterations, cpuMicroseconds: (cpu.user + cpu.system) / iterations, rows });
        } finally { installed?.dispose(); }
      }
    }
  }
}
const summary = [];
for (const fixture of Object.keys(samples)) for (const phase of ['cached', 'resize', 'first-paint', 'streaming', 'growing-code']) {
  const select = variant => results.filter(x => x.fixture === fixture && x.phase === phase && x.variant === variant).map(x => x.microseconds);
  const native = median(select('native')), candidateUs = median(select('candidate'));
  const baselineUs = baseline ? median(select('baseline')) : native;
  summary.push({ fixture, phase, nativeUs: native, baselineUs, candidateUs, deltaUs: candidateUs - baselineUs, ratio: candidateUs / baselineUs,
    nativeMAD: median(select('native').map(x => Math.abs(x - native))), baselineMAD: median(select(baseline ? 'baseline' : 'native').map(x => Math.abs(x - baselineUs))), candidateMAD: median(select('candidate').map(x => Math.abs(x - candidateUs))) });
}
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const report = { runtime: process.version, pi: version, trials, iterations, baselinePath, hashes: { candidate: digest(repo + '/pi/.pi/agent/extensions/code-blocks/index.ts'), ...(baselinePath ? { baseline: digest(baselinePath) } : {}) }, summary, results };
if (process.env.CODEBLOCK_BENCH_REPORT) writeFileSync(process.env.CODEBLOCK_BENCH_REPORT, JSON.stringify(report, null, 2));
console.log(`Pi ${version}, ${process.version}, ${trials} alternating trials, ${iterations} iterations`);
console.log('fixture    phase          native us   baseline us   candidate us   delta us   ratio');
for (const row of summary) console.log(`${row.fixture.padEnd(10)} ${row.phase.padEnd(13)} ${row.nativeUs.toFixed(2).padStart(10)} ${row.baselineUs.toFixed(2).padStart(13)} ${row.candidateUs.toFixed(2).padStart(14)} ${row.deltaUs.toFixed(2).padStart(10)} ${row.ratio.toFixed(2).padStart(7)}`);
