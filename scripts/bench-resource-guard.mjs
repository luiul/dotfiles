#!/usr/bin/env node
/** Measure the actual reviewed patch checks and removed run-boundary overhead. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const baseline = resolve(arg('--baseline') || '');
assert(arg('--baseline'));
const candidate = resolve('pi/.pi/agent/extensions/resource-budget.ts');
const version = readFileSync(join(homedir(), '.pi/agent/install/current-version'), 'utf8').trim();
const modules = join(homedir(), '.pi/agent/install/releases', version, 'node_modules');
const { createJiti } = await import(pathToFileURL(join(modules, 'jiti/lib/jiti.mjs')).href);
const loader = createJiti(import.meta.url);
const variants = { baseline: await loader.import(baseline), candidate: await loader.import(candidate) };
const hashes = Object.fromEntries(Object.entries({ baseline, candidate }).map(([name, path]) => [name, createHash('sha256').update(readFileSync(path)).digest('hex')]));
const packageDir = join(homedir(), '.pi/agent/npm/node_modules/context-mode');
const samples = { baseline: [], candidate: [] }, runs = { baseline: [], candidate: [] };
const hooks = {};
for (const [name, module] of Object.entries(variants)) { const handlers = new Map(); module.default({ on(event, handler) { handlers.set(event, handler); } }); hooks[name] = handlers; assert.equal(module.verifyResourcePatch(packageDir), undefined); }
for (let warm = 0; warm < 20; warm++) for (const module of Object.values(variants)) module.verifyResourcePatch(packageDir);
for (let repeat = 0; repeat < 9; repeat++) for (const name of repeat % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
  let start = performance.now();
  for (let i = 0; i < 20; i++) assert.equal(variants[name].verifyResourcePatch(packageDir), undefined);
  samples[name].push((performance.now() - start) / 20);
  start = performance.now();
  for (let i = 0; i < 20; i++) await hooks[name].get('before_agent_start')?.({});
  runs[name].push((performance.now() - start) / 20);
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const stats = values => { const m = median(values); return { medianMs: m, madMs: median(values.map(v => Math.abs(v - m))) }; };
const report = { pi: version, node: process.version, hashes, repeats: 9, iterations: 20, rotatedOrder: true, checks: Object.fromEntries(Object.entries(samples).map(([n, v]) => [n, stats(v)])), runBoundary: Object.fromEntries(Object.entries(runs).map(([n, v]) => [n, stats(v)])), limits: 'Warm source-file hashing only. No tool execution, bridge lifecycle or whole-task speed claim.' };
for (const [name, path] of Object.entries({ baseline, candidate })) assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), hashes[name]);
if (arg('--output')) writeFileSync(resolve(arg('--output')), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
