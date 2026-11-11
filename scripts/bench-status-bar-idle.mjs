#!/usr/bin/env node
/** Real idle Pi A/B diagnostic. Node and macOS only. No model requests or user clipboard writes.
 * node scripts/bench-status-bar-idle.mjs --baseline /absolute/path/status-bar.ts --output /tmp/status-bar-idle.json
 * Optional: --candidate PATH --pi-cli PATH --repeats 7 --slice-ms 5000 --width 160 --mode regular
 * Two private Rex hosts stay alive across alternating slices. Startup is outside idle measurements.
 * PI_TUI_WRITE_LOG and a logging Git wrapper run in both hosts. This is not a renderer microbenchmark.
 * Revalidate baseline and candidate on Rex only. Never compare these timings with a tmux report.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { RexTestDriver } from './rex-test-driver.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const allowed = new Set(['baseline', 'candidate', 'pi-cli', 'output', 'repeats', 'slice-ms', 'width', 'mode']);
const options = {};
for (let i = 0; i < args.length; i++) {
  const match = args[i].match(/^--([^=]+)(?:=(.*))?$/);
  assert(match && allowed.has(match[1]), `Unknown argument: ${args[i]}`);
  const value = match[2] ?? args[++i];
  assert(value && !value.startsWith('--'), `Missing value for --${match[1]}`);
  assert(!(match[1] in options), `Repeated option: --${match[1]}`);
  options[match[1]] = value;
}
function integer(name, fallback, min, max) {
  const n = Number(options[name] ?? fallback);
  assert(Number.isSafeInteger(n) && n >= min && n <= max, `--${name} must be ${min}..${max}`);
  return n;
}
assert(process.platform === 'darwin', 'This benchmark uses macOS ps CPU time and RSS');
assert(!process.versions.bun, 'Run with Node, not Bun');
assert(options.baseline, 'Supply --baseline PATH, normally extracted from HEAD:pi/.pi/agent/extensions/status-bar.ts');
const baseline = resolve(options.baseline);
const candidate = resolve(options.candidate ?? join(repo, 'pi/.pi/agent/extensions/status-bar.ts'));
const cli = resolve(options['pi-cli'] ?? join(homedir(), '.pi/agent/install/current/node_modules/@earendil-works/pi-coding-agent/dist/cli.js'));
const fixture = join(repo, 'scripts/fixtures/status-bar-live.ts');
const preload = join(repo, 'scripts/fixtures/status-bar-clipboard.cjs');
const output = options.output && options.output !== '-' ? resolve(options.output) : undefined;
const repeats = integer('repeats', 7, 7, 10);
const sliceMs = integer('slice-ms', 5000, 5000, 8000);
const width = integer('width', 160, 80, 240);
const mode = options.mode ?? 'regular';
assert(['regular', 'fullscreen'].includes(mode), '--mode must be regular or fullscreen');
// Nominal alignment waits one 4s poll. Reserve private server/host startup and
// driver cleanup too. The work deadline catches slower polls without fewer trials.
assert(repeats * 2 * (sliceMs + 4500) + 100000 <= 240000, 'Requested slices exceed the four-minute budget');
for (const path of [baseline, candidate, cli, fixture, preload]) assert(existsSync(path), `Missing ${path}`);
const piVersion = JSON.parse(readFileSync(join(dirname(dirname(cli)), 'package.json'), 'utf8')).version;
// Keep an exact fixture version gate, not a broad semver range.
const fingerprint = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const sources = Object.fromEntries([baseline, candidate, fixture, preload, fileURLToPath(import.meta.url)].map((path) => [path, fingerprint(path)]));
assert(!output || !(output in sources), 'Output must not replace a source file');
const started = new Date().toISOString();
const endAt = Date.now() + 240000;
// The driver can need 30s for supervisor stop and 6s to verify its exit.
const workEndAt = endAt - 40000;
const root = mkdtempSync(join(tmpdir(), 'sb-idle-'));
let driver;
let runtimeAttempted = false;
const owned = new Map();
const recordedPids = new Set();
const abort = new AbortController();
const watchdog = setTimeout(() => abort.abort(new Error('Four-minute benchmark deadline reached')), workEndAt - Date.now());
const provider = 'ai-model-router';
const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
const report = {
  schema_version: 2, started, runtime: process.version, executable: process.execPath,
  backend: 'Rex', driver: 'RexTestDriver', comparison_scope: 'baseline and candidate in this Rex run only',
  startup_semantics: 'First paint includes private terminal creation, macOS login, target registration and Pi startup. Shared private server startup is recorded separately. Neither timing is comparable to old tmux startup.',
  pi_version: piVersion, cli, platform: process.platform, arch: process.arch, sources,
  benchmark_command: { cwd: process.cwd(), argv: [process.execPath, ...process.argv.slice(1)] },
  settings: { repeats, slice_ms: sliceMs, git_poll_ms: 4000, width, height: 32, mode, provider, timeout_ms: 240000 },
  limitations: [
    'Idle diagnostic, not renderer timing. Both real hosts use the same installed Node and Pi version with only the local provider and status bar loaded.',
    'Two persistent hosts provide repeated idle slices, not independent process trials. The unmeasured host remains idle and its Git timer still runs.',
    'CPU is macOS ps time for the actual Node target PID only, excluding Git, login, shell, Rex server, controller, supervisor and sampler CPU. Display resolution is 10ms; a zero delta means below this resolution, not zero work.',
    'Slice CPU percentages are fractions of one core. The nominal five-second slices include endpoint sampling overhead; wall time uses ps command midpoints.',
    'Slices begin after a fresh Git status launch has exited and a 100ms drain. A four-second timer normally produces one status launch in a five-second slice; actual counts are retained.',
    'The Git wrapper logs launches with zsh builtin timestamps before exec of real Git. Log counts include core Pi Git calls, not just status bar calls.',
    'PI_TUI_WRITE_LOG adds synchronous file I/O in both variants. ANSI deltas are logged bytes, not write-call or render counts. Log reads occur in the parent only.',
    'RSS is absolute sampled host RSS, not retained extension memory or peak RSS. No GC is forced.',
    'First paint is observed through Rex at 150ms polling intervals plus capture overhead. One startup per variant is descriptive only and cannot support startup speed claims. Terminal backend timings must never be compared across Rex and tmux.',
    'No network request is made by the local provider. Private HOME, config and seeded sessions are removed after the run. No user Pi host or demo session is changed.',
    'Order alternates baseline/candidate and candidate/baseline. This diagnostic does not measure streaming, tools, other extensions or the full daily configuration.',
    'The driver verifies cleanup of its server and registered exec targets. Unknown self-detaching descendants are outside its proven cleanup scope.',
  ], hosts: [], slices: [], raw_logs: [], failures: [], cleanup: {},
};
function run(binary, argv, optional = false, maxMs = 5000) {
  try {
    assert(Date.now() < endAt, 'Cleanup deadline reached');
    return execFileSync(binary, argv, { encoding: 'utf8', timeout: Math.max(1, Math.min(maxMs, endAt - Date.now())), stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    if (optional) return '';
    throw new Error(`${binary} ${argv.join(' ')}: ${error.stderr ?? error.message}`);
  }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function checkDeadline() { abort.signal.throwIfAborted(); assert(Date.now() < workEndAt, 'Work deadline reached'); }
async function sleep(ms, cleanup = false) {
  if (!cleanup) checkDeadline();
  await new Promise((done) => setTimeout(done, ms));
  if (!cleanup) checkDeadline();
}
function events(host) {
  if (!existsSync(host.events)) return [];
  const text = readFileSync(host.events, 'utf8');
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(JSON.parse);
}
function gitCalls(host) {
  if (!existsSync(host.gitLog)) return [];
  const text = readFileSync(host.gitLog, 'utf8');
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map((line) => {
    const [at, pid, parent, ...argv] = line.split('\t');
    return { at_ms: Number(at) * 1000, pid: Number(pid), parent_pid: Number(parent), args: argv.join('\t') };
  });
}
const isStatus = (call) => /^status(?:\s|$)/.test(call.args);
function hostErrors(host, screen = '') {
  if (host.pid) assert(alive(host.pid), `${host.variant} Pi host exited`);
  assert(!/Extension error|Extension ".*" error:|Failed to load extension|Unhandled|uncaughtException|TypeError:|Error in render|exceeds terminal width/i.test(screen), `Host error: ${screen}`);
  const list = events(host);
  assert(!list.some((e) => ['fixture-error', 'clipboard-blocked', 'response-start', 'working', 'clipboard'].includes(e.type)), `Unsafe or non-idle fixture activity: ${JSON.stringify(list)}`);
  for (const call of gitCalls(host)) {
    assert(host.pid, 'Git launched before the actual Node target PID was recorded');
    assert.equal(call.parent_pid, host.pid, 'Unexpected Git wrapper owner');
    host.gitPids.add(call.pid);
  }
  return list;
}
function seed(area) {
  const timestamp = new Date().toISOString();
  const uuid = randomUUID();
  const usage = { input: 30000, output: 1000, cacheRead: 40000, cacheWrite: 0, totalTokens: 71000,
    cost: { input: 0.03, output: 0.002, cacheRead: 0.004, cacheWrite: 0, total: 0.036 } };
  const records = [
    { type: 'session', version: 3, id: uuid, timestamp, cwd: repo },
    { type: 'model_change', id: 'm0000001', parentId: null, timestamp, provider, modelId: 'fixture' },
    { type: 'message', id: 'u0000001', parentId: 'm0000001', timestamp, message: { role: 'user', content: [{ type: 'text', text: 'SB_SEEDED' }], timestamp: Date.now() } },
    { type: 'message', id: 'a0000001', parentId: 'u0000001', timestamp, message: { role: 'assistant', api: 'sb-live-stream', provider, model: 'fixture', timestamp: Date.now(),
      content: [{ type: 'text', text: 'SB_SEED_DONE' }], stopReason: 'stop', usage } },
  ];
  const file = join(area, 'sessions', `seed_${uuid}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { file, uuid };
}
async function start(variant, source, realGit) {
  checkDeadline();
  const area = join(root, variant);
  const home = join(area, 'home');
  const config = join(home, '.pi/agent');
  const bin = join(area, 'bin');
  mkdirSync(config, { recursive: true }); mkdirSync(bin);
  const host = { variant, area, name: `ag-sb-idle-${process.pid}-${variant}`, events: join(area, 'events.jsonl'),
    ansiLog: join(area, 'ansi.log'), gitLog: join(area, 'git.tsv'), pid: undefined, gitPids: new Set() };
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ quietStartup: true, theme: 'dark', defaultProvider: provider, defaultModel: 'fixture',
    compaction: { enabled: true, reserveTokens: 16384 }, retry: { enabled: false }, cacheWarming: 'off', enableInstallTelemetry: false,
    enableAnalytics: false, fullscreenCopyOnSelect: false }));
  // Only cached production Git launches are counted. Exec preserves the wrapper PID.
  writeFileSync(join(bin, 'git'), '#!/bin/zsh -f\nzmodload zsh/datetime\nprintf \'%s\\t%s\\t%s\\t%s\\n\' "$EPOCHREALTIME" "$$" "$PPID" "$*" >> "$SB_IDLE_GIT_LOG"\nexec "$SB_IDLE_REAL_GIT" "$@"\n', { mode: 0o700 });
  const copy = join(area, 'status-bar.ts');
  writeFileSync(copy, readFileSync(source));
  const initial = seed(area);
  const env = { HOME: home, PATH: `${bin}:${process.env.PATH}`, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8',
    PI_CODING_AGENT_DIR: config, PI_SKIP_VERSION_CHECK: '1', PI_OFFLINE: '1', PI_TRUE_COLOR: '1', PI_IMAGE_PROTOCOL: 'none',
    PI_TUI_WRITE_LOG: host.ansiLog, SB_LIVE_EVENTS: host.events, SB_LIVE_PROVIDER: provider, SB_IDLE_GIT_LOG: host.gitLog,
    SB_IDLE_REAL_GIT: realGit, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    NODE_OPTIONS: `--require ${JSON.stringify(preload)}` };
  const argv = [process.execPath, cli, '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
    '--no-approve', '--no-mcp', '--no-themes', '--no-tools', '--thinking', 'off', '--provider', provider, '--model', 'fixture',
    '--tui-mode', mode, '--use-theme', 'dark', '--session-dir', join(area, 'sessions'), '--session', initial.file, '-e', fixture, '-e', copy];
  const launch = `cd ${quote(repo)} && exec env -i ${Object.entries(env).map(([k, v]) => quote(`${k}=${v}`)).join(' ')} ${argv.map(quote).join(' ')}`;
  const observation = { variant, source, source_sha256: sources[source], fixture_command: { cwd: repo, argv, env, shell: launch } };
  report.hosts.push(observation);
  // Direct create includes private terminal creation, login and registration.
  // The driver owns teardown. Rex's outer login PID is never sampled as Pi.
  const t0 = performance.now();
  Object.assign(host, driver.create({ name: host.name, command: argv, cwd: repo, env, columns: width, rows: 32 }));
  owned.set(host.name, host);
  const until = Math.min(Date.now() + 20000, workEndAt);
  while (Date.now() < until) {
    checkDeadline();
    host.pid ??= driver.pid(host);
    if (host.pid) recordedPids.add(host.pid);
    const screen = driver.capture(host);
    observation.last_screen = screen;
    assert(!driver.process(host).last_exit, `${variant} Pi host exited: ${screen}`);
    const list = hostErrors(host, screen);
    const ready = list.find((e) => e.type === 'ready');
    if (ready && screen.includes(initial.uuid) && screen.includes('GPT-6.1 Sol')) {
      assert.equal(ready.pid, host.pid); assert.equal(ready.mode, 'tui'); assert.equal(ready.uuid, initial.uuid);
      assert.equal(ready.cwd, repo); assert.equal(ready.provider, provider);
      assert(list.some((e) => e.type === 'clipboard-preload') && list.some((e) => e.type === 'clipboard-safe'));
      assert.deepEqual([...ready.commands].sort(), ['sb-live-model', 'sb-live-snapshot', 'sb-live-theme', 'session-ref', 'statusbar'].sort(), 'Inherited extension commands');
      Object.assign(observation, { pid: host.pid, first_paint_observed_ms: performance.now() - t0, first_screen: screen });
      return host;
    }
    await sleep(150);
  }
  throw new Error(`${variant} first paint timed out`);
}
function sample(host) {
  assert(Number.isSafeInteger(host.pid) && host.pid > 1 && alive(host.pid), 'Actual Node target PID is needed for sampling');
  const before = performance.now();
  const text = run('/bin/ps', ['-o', 'time=,rss=', '-p', String(host.pid)]).trim();
  const after = performance.now();
  const match = text.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+\.\d{2})\s+(\d+)$/);
  assert(match, `Unexpected macOS ps time/RSS: ${text}`);
  const cpuCs = Math.round((Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3]) * 60 + Number(match[4])) * 100);
  return { midpoint_ms: (before + after) / 2, sampler_ms: after - before, cpu_centiseconds: cpuCs,
    rss_bytes: Number(match[5]) * 1024, ansi_bytes: existsSync(host.ansiLog) ? statSync(host.ansiLog).size : 0,
    git_calls: gitCalls(host).length };
}
async function align(host) {
  hostErrors(host);
  const previous = gitCalls(host).filter(isStatus).length;
  const until = Math.min(Date.now() + 6500, workEndAt);
  while (Date.now() < until) {
    hostErrors(host);
    const calls = gitCalls(host).filter(isStatus);
    const latest = calls.at(-1);
    if (calls.length > previous && latest && !alive(latest.pid)) {
      await sleep(100);
      return { poll_at_ms: latest.at_ms, poll_pid: latest.pid };
    }
    await sleep(75);
  }
  throw new Error(`${host.variant} did not complete a fresh Git poll within 6.5s`);
}
async function measure(host, trial, order) {
  const alignment = await align(host);
  const before = sample(host);
  await sleep(sliceMs);
  const after = sample(host);
  hostErrors(host);
  const calls = gitCalls(host).slice(before.git_calls, after.git_calls);
  const wallMs = after.midpoint_ms - before.midpoint_ms;
  const cpuCs = after.cpu_centiseconds - before.cpu_centiseconds;
  assert(cpuCs >= 0 && after.ansi_bytes >= before.ansi_bytes, 'Counters went backwards');
  const row = { variant: host.variant, trial, order, alignment, wall_ms: wallMs, cpu_centiseconds: cpuCs,
    cpu_ms: cpuCs * 10, cpu_percent_one_core: cpuCs * 10 / wallMs * 100,
    rss_before_bytes: before.rss_bytes, rss_after_bytes: after.rss_bytes, ansi_bytes: after.ansi_bytes - before.ansi_bytes,
    git_calls: calls.length, git_status_calls: calls.filter(isStatus).length, git_launches: calls,
    sampler_before_ms: before.sampler_ms, sampler_after_ms: after.sampler_ms };
  report.slices.push(row);
  process.stderr.write(`${trial + 1}/${repeats} ${host.variant}: CPU ${row.cpu_ms}ms, ANSI ${row.ansi_bytes} bytes, Git ${row.git_calls}\n`);
}
function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  const i = (sorted.length - 1) * q;
  return sorted[Math.floor(i)] + (sorted[Math.ceil(i)] - sorted[Math.floor(i)]) * (i - Math.floor(i));
}
function summarize(variant) {
  const rows = report.slices.filter((r) => r.variant === variant);
  if (!rows.length) return { variant, samples: 0 };
  const metric = (key) => {
    const values = rows.map((r) => r[key]);
    const median = quantile(values, 0.5);
    return { median, mad: quantile(values.map((v) => Math.abs(v - median)), 0.5),
      min: Math.min(...values), max: Math.max(...values), p95: quantile(values, 0.95) };
  };
  return { variant, samples: rows.length, cpu_ms: metric('cpu_ms'), cpu_percent_one_core: metric('cpu_percent_one_core'),
    ansi_bytes: metric('ansi_bytes'), git_calls: metric('git_calls'), git_status_calls: metric('git_status_calls'),
    rss_after_bytes: metric('rss_after_bytes'), rss_max_sampled_bytes: Math.max(...rows.flatMap((r) => [r.rss_before_bytes, r.rss_after_bytes])) };
}
async function stop(host) {
  host.pid ??= driver.pid(host);
  if (host.pid) recordedPids.add(host.pid);
  for (const call of gitCalls(host)) host.gitPids.add(call.pid);
  if (!driver.process(host).last_exit) {
    driver.key(host, 'ctrl+u');
    driver.key(host, 'ctrl+d');
    const until = Math.min(Date.now() + 1200, endAt - 38000);
    while (host.pid && alive(host.pid) && Date.now() < until) await sleep(75, true);
  }
  driver.close(host);
  host.closed = true;
  // Identity-checked termination of survivors belongs to the driver's stop.
}
process.once('SIGTERM', () => abort.abort(new Error('Benchmark interrupted by SIGTERM')));
process.once('SIGINT', () => abort.abort(new Error('Benchmark interrupted by SIGINT')));
try {
  const head = run('git', ['-C', repo, 'rev-parse', 'HEAD']).trim();
  const headSource = run('git', ['-C', repo, 'show', 'HEAD:pi/.pi/agent/extensions/status-bar.ts']);
  report.baseline_provenance = { head, matches_head: createHash('sha256').update(headSource).digest('hex') === sources[baseline] };
  // Parent verified managed Pi 1.5.1 with this same status-bar-live.ts fixture:
  // test-status-bar-live.mjs passed all 142 checks, plus test-pi-resource-e2e.mjs
  // passed its 8s run. This proves 1.5.1 only, not later releases.
  assert(['1.4.0', '1.5.0', '1.5.1'].includes(piVersion), 'The local fixture supports Pi 1.4.0, 1.5.0 and verified 1.5.1');
  const realGit = run('/usr/bin/which', ['git']).trim();
  assert(realGit.startsWith('/'), 'Real Git path must be absolute');
  report.git_executable = realGit;
  const runtimeStarted = performance.now();
  runtimeAttempted = true;
  driver = await RexTestDriver.start({ deadlineMs: Math.max(1000, workEndAt - Date.now()) });
  report.private_runtime_startup_ms = performance.now() - runtimeStarted;
  checkDeadline();
  const hosts = { baseline: await start('baseline', baseline, realGit), candidate: await start('candidate', candidate, realGit) };
  for (let trial = 0; trial < repeats; trial++) {
    const order = trial % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
    for (let i = 0; i < order.length; i++) await measure(hosts[order[i]], trial, i);
  }
} catch (error) {
  report.failures.push(String(error));
} finally {
  clearTimeout(watchdog);
  for (const host of owned.values()) {
    try { hostErrors(host); } catch (error) { report.failures.push(String(error)); }
    try { await stop(host); } catch (error) { report.failures.push(`Cleanup: ${error}`); }
  }
  await sleep(200, true);
  if (driver) {
    try { report.cleanup.driver_result = await driver.stop(); }
    catch (error) { report.failures.push(`Private Rex cleanup: ${error}`); }
  }
  // Preserve exact writes and fixture events before removing the private HOME.
  for (const host of owned.values()) {
    try {
      for (const call of gitCalls(host)) host.gitPids.add(call.pid);
      const raw = (path) => existsSync(path) ? readFileSync(path, 'utf8') : '';
      report.raw_logs.push({ variant: host.variant, events_jsonl: raw(host.events), git_tsv: raw(host.gitLog), ansi: raw(host.ansiLog) });
    } catch (error) { report.failures.push(`Raw logs: ${error}`); }
  }
  report.cleanup.host_pids_exited = [...recordedPids].every((pid) => !alive(pid));
  report.cleanup.rex_sessions_removed = [...owned.values()].every((host) => host.closed);
  // A rejected start has no driver handle. Do not claim its cleanup was verified.
  report.cleanup.private_rex_runtime_removed = driver ? !existsSync(driver.root) : runtimeAttempted ? null : true;
  report.cleanup.git_pids_exited = [...owned.values()].every((host) => [...host.gitPids].every((pid) => !alive(pid)));
  report.cleanup.sources_unchanged = Object.entries(sources).every(([path, sha]) => existsSync(path) && fingerprint(path) === sha);
  rmSync(root, { recursive: true, force: true });
  report.cleanup.fixture_directories_removed = !existsSync(root);
  for (const [check, passed] of Object.entries(report.cleanup)) if (passed === false) report.failures.push(`Cleanup check failed: ${check}`);
  report.strays_audit = run('reap-strays', ['--dry-run', '--report'], true, 2000).slice(-4000);
}
report.finished = new Date().toISOString();
report.summary = ['baseline', 'candidate'].map(summarize);
report.paired_deltas = Array.from({ length: repeats }, (_, trial) => {
  const a = report.slices.find((r) => r.trial === trial && r.variant === 'baseline');
  const b = report.slices.find((r) => r.trial === trial && r.variant === 'candidate');
  return a && b ? { trial, candidate_minus_baseline_cpu_ms: b.cpu_ms - a.cpu_ms,
    candidate_minus_baseline_cpu_percent_one_core: b.cpu_percent_one_core - a.cpu_percent_one_core,
    candidate_minus_baseline_ansi_bytes: b.ansi_bytes - a.ansi_bytes,
    candidate_minus_baseline_git_calls: b.git_calls - a.git_calls,
    candidate_minus_baseline_rss_after_bytes: b.rss_after_bytes - a.rss_after_bytes } : undefined;
}).filter(Boolean);
report.complete = report.failures.length === 0 && report.slices.length === repeats * 2;
report.status = report.complete ? 'complete' : report.slices.length ? 'incomplete' : 'blocked';
const json = JSON.stringify(report, null, 2) + '\n';
if (output) {
  writeFileSync(output, json);
  for (const row of report.summary) console.log(`${row.variant}: ${row.samples} slices, median CPU ${row.cpu_ms?.median ?? 'n/a'}ms, median ANSI ${row.ansi_bytes?.median ?? 'n/a'} bytes, median Git ${row.git_calls?.median ?? 'n/a'}`);
  console.log(`JSON: ${output}`);
} else process.stdout.write(json);
if (!report.complete) {
  process.stderr.write(`Benchmark incomplete: ${report.failures.join('; ')}\n`);
  process.exitCode = 1;
}
