#!/usr/bin/env node
/** Real Pi TUI checks. No network, global config changes, or user-session input.
 * Run: node scripts/test-filechanges-live.mjs
 * Optional: FC_LIVE_BASELINE=/path/to/baseline FC_LIVE_REPEATS=3
 * FC_LIVE_PI_CLI overrides the installed Pi dist/cli.js path.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidate = join(repo, 'pi/.pi/agent/extensions/filechanges.ts');
const current = join(homedir(), 'dotfiles/pi/.pi/agent/extensions/filechanges.ts');
const zen = join(homedir(), 'dotfiles/pi/.pi/agent/extensions/zen.ts');
const fixture = join(repo, 'scripts/fixtures/filechanges-live.ts');
const cli = process.env.FC_LIVE_PI_CLI ?? join(homedir(), '.pi/agent/install/current/node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
const baseline = process.env.FC_LIVE_BASELINE;
const repeats = Number(process.env.FC_LIVE_REPEATS ?? 3);
assert(Number.isInteger(repeats) && repeats >= 0 && repeats <= 10, 'FC_LIVE_REPEATS must be 0 through 10');
for (const file of [candidate, zen, fixture, cli]) assert(existsSync(file), `Missing ${file}`);
const root = mkdtempSync(join(homedir(), '.fc-live-'));
const owned = new Set();
const pids = new Set();
const report = { runtime: process.execPath, cli, zen, checks: [], failures: [], startup: {}, idle: [],
  measurement: { repeats, pollingMs: 120, statistic: 'nearest-rank p95, descriptive only for small samples', startup: 'Node launch to first captured model/footer paint, excludes watchdog registration', pane: '100x32', liveZenInEveryVariant: true }, sources: {} };
const suiteDeadline = Date.now() + 12 * 60_000;
const shellQuote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const sourceFiles = [candidate, current, zen, join(dirname(candidate), 'filechanges-tracker.ts'), join(dirname(current), 'filechanges-tracker.ts')].filter(existsSync);
const sourceHashes = new Map(sourceFiles.map((p) => [p, hash(p)]));
report.sources = Object.fromEntries(sourceHashes);
let sequence = 0;
function run(command, args, optional = false) {
  try { return execFileSync(command, args, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { if (optional) return ''; throw new Error(`${command} ${args.join(' ')}: ${error.stderr ?? error.message}`); }
}
function tmux(...args) { return run('tmux', args); }
function events(host) {
  if (!existsSync(host.events)) return [];
  return readFileSync(host.events, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
function capture(host, ansi = false) { return tmux('capture-pane', '-p', ...(ansi ? ['-e'] : []), '-t', host.name); }
function panel(text) { return text.split('\n').filter((line) => line.includes('│ ')).join('\n'); }
function failOnHostErrors(text) {
  assert(!/Extension error|Extension ".*" error:|Failed to load extension|Unhandled|uncaughtException|TypeError:|Error in render|exceeds terminal width/i.test(text), `Host error:\n${text}`);
}
async function wait(host, predicate, description, ms = 45_000) {
  const until = Math.min(Date.now() + ms, suiteDeadline);
  let last = '';
  while (Date.now() < until) {
    last = capture(host);
    failOnHostErrors(last);
    const list = events(host);
    assert(!list.some((e) => e.type === 'fixture-error'), JSON.stringify(list));
    if (predicate(last, list)) return last;
    await sleep(120);
  }
  throw new Error(`Timed out: ${description}\n${last}\nEvents: ${JSON.stringify(events(host))}`);
}
function input(host, text) { tmux('send-keys', '-t', host.name, '-l', text); }
function key(host, name) { tmux('send-keys', '-t', host.name, name); }
async function command(host, text) { key(host, 'C-u'); input(host, text); key(host, 'Enter'); await sleep(150); }
async function stable(host) {
  let previous = '';
  for (let i = 0; i < 40; i++) {
    const now = capture(host);
    failOnHostErrors(now);
    if (now === previous) return now;
    previous = now;
    await sleep(150);
  }
  throw new Error('TUI failed to settle');
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function stop(host) {
  // Ctrl+D on the empty core editor requests Pi shutdown. Escape also closes a List.
  run('tmux', ['send-keys', '-t', host.name, 'Escape'], true);
  await sleep(40);
  run('tmux', ['send-keys', '-t', host.name, 'C-u', 'C-d'], true);
  const until = Date.now() + 2500;
  while (host.pid && alive(host.pid) && Date.now() < until) await sleep(100);
  run('tmux', ['kill-session', '-t', host.name], true);
  owned.delete(host.name);
  // A session kill sends SIGHUP. Escalate only the exact PID this fixture recorded.
  if (host.pid && alive(host.pid)) {
    try { process.kill(host.pid, 'SIGTERM'); } catch {}
    await sleep(300);
    if (alive(host.pid)) { try { process.kill(host.pid, 'SIGKILL'); } catch {} }
  }
}
function seed(dir, count = 40) {
  const sessions = join(dir, 'sessions');
  mkdirSync(sessions, { recursive: true });
  const file = join(sessions, 'seed.jsonl');
  const timestamp = new Date().toISOString();
  const items = Array.from({ length: count }, (_, i) => {
    const name = `seed-${String(i + 1).padStart(2, '0')}.txt`;
    writeFileSync(join(dir, name), `seed ${i + 1}\n`);
    return { path: name, absPath: join(dir, name), kind: 'created', added: 1, removed: 0, binary: false, updatedAt: count - i };
  });
  const entries = [
    { type: 'session', version: 3, id: randomUUID(), timestamp, cwd: dir },
    { type: 'model_change', id: 'm1', parentId: null, timestamp, provider: 'fc-live', modelId: 'fixture' },
    { type: 'message', id: 'u1', parentId: 'm1', timestamp, message: { role: 'user', content: [{ type: 'text', text: 'FC_SEEDED' }], timestamp: Date.now() } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp, message: { role: 'assistant', api: 'fc-live-stream', provider: 'fc-live', model: 'fixture', timestamp: Date.now(), content: [{ type: 'text', text: 'FC_SEED_DONE' }], stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
    { type: 'custom', id: 'c1', parentId: 'a1', timestamp, customType: 'filechanges:session-set', data: { items, promptPaths: [] } },
  ];
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}
async function start(label, extension, { dir, session, width = 100, height = 32 } = {}) {
  const area = join(root, `host-${++sequence}`);
  mkdirSync(area);
  dir ??= join(area, 'files');
  mkdirSync(dir, { recursive: true });
  const config = join(area, 'agent');
  mkdirSync(config);
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ quietStartup: true, theme: 'dark', defaultProvider: 'fc-live', defaultModel: 'fixture', compaction: { enabled: false }, retry: { enabled: false } }));
  const host = { label, name: `ag-fc-${process.pid}-${sequence}`, dir, events: join(area, 'events.jsonl'), log: join(area, 'ansi.log'), area };
  const env = { HOME: homedir(), PATH: process.env.PATH, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8',
    PI_CODING_AGENT_DIR: config, PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', PI_OFFLINE: '1', PI_TRUE_COLOR: '1', PI_IMAGE_PROTOCOL: 'none',
    PI_TUI_WRITE_LOG: host.log, FC_LIVE_EVENTS: host.events, ...(extension ? { FC_LIVE_EXTENSION: extension } : {}) };
  const args = [process.execPath, cli, '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve', '--no-mcp', '--no-themes', '--thinking', 'off', '--provider', 'fc-live', '--model', 'fixture', '--tui-mode', 'fullscreen', '--use-theme', 'dark', '--session-dir', join(dir, 'sessions'), '-e', zen, '--zen', '-e', fixture, ...(session ? ['--session', session] : [])];
  const launch = `cd ${shellQuote(dir)} && exec env -i ${Object.entries(env).map(([k, v]) => shellQuote(`${k}=${v}`)).join(' ')} ${args.map(shellQuote).join(' ')}`;
  // Register the bounded, private bootstrap before starting the measured Node host.
  tmux('new-session', '-d', '-s', host.name, '-x', String(width), '-y', String(height), '/bin/sleep 720');
  owned.add(host.name);
  try {
    const registrationStart = performance.now();
    run('reap-strays', ['--register-tmux', host.name, '--owner', String(process.pid), '--deadline', String(Math.ceil(suiteDeadline / 1000))]);
    host.registrationMs = Math.round(performance.now() - registrationStart);
    const t0 = performance.now();
    const wallStart = Date.now();
    tmux('respawn-pane', '-k', '-t', host.name, launch);
    const first = await wait(host, (text, list) => list.some((e) => e.type === 'ready') && /fixture|FC Live Fixture/.test(text) && /%\//.test(text), 'first interactive paint');
    host.startupMs = Math.round(performance.now() - t0);
    const ready = events(host).find((e) => e.type === 'ready');
    host.hookReadyMs = ready.at - wallStart;
    assert.equal(ready.mode, 'tui');
    host.pid = ready.pid;
    host.session = ready.session;
    pids.add(host.pid);
    const expectedCommands = ['zen', 'fc-live-draft', 'fc-live-theme', ...(extension ? ['filechanges', 'filechanges-clear'] : [])];
    const variantSource = extension ? readFileSync(extension, 'utf8') : '';
    for (const match of variantSource.matchAll(/registerCommand\(\s*["']([^"']+)["']/g)) if (!expectedCommands.includes(match[1])) expectedCommands.push(match[1]);
    assert.deepEqual([...ready.commands].sort(), expectedCommands.sort(), 'Unexpected inherited extension commands');
    failOnHostErrors(first);
    await stable(host);
    const fields = run('/bin/ps', ['-p', String(host.pid), '-o', '%cpu=', '-o', 'rss=', '-o', 'time=']).trim().split(/\s+/);
    host.resources = { cpuPercent: Number(fields[0]), rssKiB: Number(fields[1]), cumulativeCpuTime: fields.slice(2).join(' '), observed: 'after first stable paint' };
    return host;
  } catch (error) {
    for (const event of events(host)) if (event.pid) { host.pid = event.pid; pids.add(event.pid); }
    await stop(host);
    throw error;
  }
}
async function prompt(host, text) {
  const count = events(host).filter((e) => e.type === 'settled').length;
  await command(host, text);
  await wait(host, (_text, list) => list.filter((e) => e.type === 'settled').length > count, text + ' settles');
  return stable(host);
}
function check(name) { report.checks.push(name); console.log(`PASS ${name}`); }
function verify(name, fn) {
  try { fn(); check(name); }
  catch (error) { report.failures.push({ name, error: String(error).slice(0, 2000) }); console.error(`FAIL ${name}: ${error.message}`); }
}
async function scenario(name, fn) {
  try { await fn(); }
  catch (error) { report.failures.push({ name, error: String(error).slice(0, 2500) }); console.error(`FAIL ${name}: ${error.message}`); }
}
async function idle(host, label) {
  await stable(host);
  await sleep(300);
  const a = statSync(host.log).size;
  await sleep(1200);
  const b = statSync(host.log).size;
  await sleep(1200);
  const c = statSync(host.log).size;
  const bytes = readFileSync(host.log).subarray(a, c);
  report.idle.push({ label, sliceMs: 1200, bytes: [b - a, c - b], panelTextWrites: (bytes.toString().match(/Session changes|seed-\d+\.txt/g) ?? []).length });
  assert.deepEqual([b - a, c - b], [0, 0], 'Static fixture wrote ANSI bytes while idle');
  check('static candidate Panel writes zero bytes in two 1.2-second idle slices');
}
async function runBehavior() {
  let host = await start('candidate', candidate);
  try {
    let text = await prompt(host, 'FC_CREATE');
    assert.equal(readFileSync(join(host.dir, 'alpha.txt'), 'utf8'), 'alpha.txt\n');
    assert.equal(readFileSync(join(host.dir, 'beta.txt'), 'utf8'), 'beta.txt\n');
    assert(panel(text).includes('alpha.txt') && panel(text).includes('beta.txt'));
    assert(panel(text).includes('2 this prompt'));
    check('real write tools create two files and Panel marks both');
    text = await prompt(host, 'accidental no-edit prompt');
    assert(panel(text).includes('alpha.txt') && panel(text).includes('beta.txt'));
    assert(!panel(text).includes('this prompt'));
    check('no-edit prompt preserves Session set and clears Prompt activity');
    text = await prompt(host, 'FC_MUTATE');
    const rows = panel(text).split('\n');
    assert(rows.find((line) => line.includes('alpha.txt'))?.includes('this prompt'));
    assert(!rows.find((line) => line.includes('beta.txt'))?.includes('this prompt'));
    assert(panel(text).includes('1 this prompt'));
    assert(rows.find((line) => line.includes('alpha.txt'))?.includes('+2/-0'));
    assert(rows.find((line) => line.includes('beta.txt'))?.includes('+1/-0'));
    check('third prompt marks only alpha and keeps cumulative beta');
    const session = host.session;
    const dir = host.dir;
    await stop(host);
    host = await start('resume', candidate, { dir, session });
    text = await stable(host);
    assert(panel(text).includes('alpha.txt') && panel(text).includes('beta.txt'));
    check('resume restores the persisted Session set');
    const readyCount = events(host).filter((e) => e.type === 'ready').length;
    await command(host, '/reload');
    await wait(host, (_text, list) => list.filter((e) => e.type === 'ready').length > readyCount, 'reload');
    text = await stable(host);
    assert(panel(text).includes('alpha.txt') && panel(text).includes('beta.txt'));
    check('reload restores the Panel without user-session changes');
    const before = ['alpha.txt', 'beta.txt'].map((name) => hash(join(dir, name)));
    await command(host, '/filechanges-clear');
    text = await wait(host, (screen) => !panel(screen).includes('Session changes'), 'Clear hides Panel');
    assert.deepEqual(['alpha.txt', 'beta.txt'].map((name) => hash(join(dir, name))), before);
    const records = readFileSync(host.session, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(records.filter((e) => e.type === 'custom' && e.customType === 'filechanges:session-set').at(-1).data.items.length, 0);
    check('Clear persists an empty set and leaves file bytes unchanged');
  } finally { await stop(host); }
}
async function runList() {
  const dir = join(root, 'list-files');
  mkdirSync(dir);
  const session = seed(dir);
  const host = await start('seeded-list', candidate, { dir, session });
  try {
    let text = await stable(host);
    assert(panel(text).includes('40 files') && panel(text).includes('34 more'));
    assert.equal((panel(text).match(/seed-\d+\.txt/g) ?? []).length, 6);
    check('40-file restored Session set stays compact in Panel');
    await idle(host, 'candidate seeded static Panel');
    const settledBefore = events(host).filter((e) => e.type === 'settled').length;
    await command(host, '/filechanges');
    text = await wait(host, (screen) => screen.includes('seed-01.txt') && /^created\s+seed-/m.test(screen), '/filechanges List');
    verify('full List hides the persistent Panel', () => assert.equal(panel(text), ''));
    verify('List help/footer fits the real 100x32 viewport', () => assert(text.includes('Escape closes'), text));
    const seen = new Set();
    for (let i = 0; i < 7; i++) {
      for (const match of capture(host).matchAll(/seed-\d+\.txt/g)) seen.add(match[0]);
      input(host, '\x1b[6~');
      await sleep(180);
    }
    const pagingSeen = new Set(seen);
    verify('real /filechanges and PageDown expose all 40 files', () => assert.equal(pagingSeen.size, 40, `List page traversal missed files: ${[...pagingSeen].join(', ')}`));
    key(host, 'Home');
    await stable(host);
    for (let i = 0; i < 40; i++) {
      for (const match of capture(host).matchAll(/seed-\d+\.txt/g)) seen.add(match[0]);
      key(host, 'Down');
      await sleep(30);
    }
    verify('arrow-key List traversal exposes all 40 files', () => assert.equal(seen.size, 40, `Visible filenames: ${[...seen].join(', ')}`));
    key(host, 'End');
    text = await stable(host);
    verify('End exposes the final List file', () => assert(text.includes('seed-40.txt'), text));
    input(host, '\x1b[5~');
    text = await stable(host);
    verify('PageUp returns to the first List file', () => assert(text.includes('seed-01.txt'), text));
    key(host, 'Escape');
    text = await stable(host);
    verify('Escape restores the six-file cumulative Panel', () => {
      assert(panel(text).includes('40 files') && panel(text).includes('34 more'));
      assert.equal((panel(text).match(/seed-\d+\.txt/g) ?? []).length, 6);
    });
    await command(host, '/fc-live-draft');
    await wait(host, (screen) => /^created\s+seed-/m.test(screen), 'draft List opens');
    key(host, 'End');
    await stable(host);
    key(host, 'Escape');
    text = await wait(host, (_screen, list) => list.some((e) => e.type === 'draft-after'), 'draft List closes');
    verify('registered List handler preserves the real editor draft on Escape', () => {
      assert.equal(events(host).find((e) => e.type === 'draft-after').text, 'DRAFT keep this text');
      assert(text.includes('DRAFT keep this text'));
    });
    key(host, 'C-u');
    tmux('resize-window', '-t', host.name, '-x', '40', '-y', '24');
    text = await wait(host, (screen) => panel(screen).includes('seed-01.txt'), '40-column Panel resize');
    assert(panel(text).includes('40 files'));
    const dark = panel(capture(host, true));
    await command(host, '/fc-live-theme light');
    await wait(host, (_screen, list) => list.some((e) => e.type === 'theme' && e.success), 'theme switch');
    await stable(host);
    const light = panel(capture(host, true));
    verify('40-column resize and real theme switch keep Panel visible', () => {
      assert.notEqual(light, dark, 'Panel ANSI colors did not change with theme');
      assert(panel(capture(host)).includes('seed-01.txt'));
    });
    await command(host, '/filechanges');
    await wait(host, (screen) => /^created\s+seed-/m.test(screen), 'narrow List');
    report.navigation = { observedBeforeFinalEnd: events(host).filter((e) => e.type === 'navigation'),
      sentPageDown: 7, reachedExtensionInputListener: events(host).filter((e) => e.type === 'navigation' && e.data === '\x1b[6~').length };
    key(host, 'End');
    text = await stable(host);
    verify('List End exposes the tail at 40 columns after theme switch', () => assert(text.includes('seed-40.txt'), text));
    key(host, 'Escape');
    await stable(host);
    assert.equal(events(host).filter((e) => e.type === 'settled').length, settledBefore, 'List or draft accidentally submitted a model prompt');
    check('List navigation and draft probe never submit a model prompt');
  } finally { await stop(host); }
}
async function measureStartup() {
  const variants = [['bare(+live Zen)', null], ['current', current], ['candidate', candidate]];
  if (baseline) {
    const old = statSync(baseline).isDirectory() ? join(baseline, 'filechanges.ts') : baseline;
    assert(existsSync(old), `Missing explicit baseline ${old}`);
    variants.splice(1, 0, ['baseline', old]);
  }
  report.measurement.baseline = baseline ?? 'current live file';
  for (let r = 0; r < repeats; r++) {
    const order = variants.slice(r % variants.length).concat(variants.slice(0, r % variants.length));
    for (const [name, extension] of order) {
      for (const count of r % 2 ? [40, 0] : [0, 40]) {
        assert(Date.now() < suiteDeadline - 45_000, 'Suite deadline reached before measurement');
        const dir = join(root, `bench-${r}-${count}-${name.replace(/[^a-z]/gi, '')}`);
        mkdirSync(dir);
        const session = seed(dir, count);
        let host;
        try {
          host = await start(name, extension, { dir, session });
          (report.startup[`${name}/${count ? 'restored40' : 'empty0'}`] ??= []).push({ firstPaintMs: host.startupMs, hookReadyMs: host.hookReadyMs, registrationMs: host.registrationMs, ...host.resources });
        } finally { if (host) await stop(host); }
      }
    }
  }
  report.statistics = {};
  for (const [name, samples] of Object.entries(report.startup)) {
    const sorted = samples.map((s) => s.firstPaintMs).sort((a, b) => a - b);
    const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    report.statistics[name] = { medianMs: median, p95Ms: p95, n: sorted.length };
    console.log(`STARTUP ${name}: median=${median}ms p95=${p95}ms n=${sorted.length} samples=${samples.map((s) => s.firstPaintMs).join(',')}`);
  }
}
try {
  await scenario('prompt lifecycle, resume, reload and Clear', runBehavior);
  await scenario('List, draft, resize and theme', runList);
  await scenario('startup measurements', measureStartup);
} finally {
  for (const name of owned) run('tmux', ['kill-session', '-t', name], true);
  for (const pid of pids) {
    if (alive(pid)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  }
  await sleep(300);
  rmSync(root, { recursive: true, force: true });
  verify('owned Pi processes exited', () => { for (const pid of pids) assert(!alive(pid), `Test-owned Pi process ${pid} leaked`); });
  const remaining = run('tmux', ['list-sessions', '-F', '#{session_name}'], true).split('\n');
  verify('owned tmux sessions removed', () => assert(!remaining.some((name) => name.startsWith(`ag-fc-${process.pid}-`)), 'Test-owned tmux session leaked'));
  verify('owned fixture directories removed', () => assert(!existsSync(root)));
  const changedSources = [...sourceHashes].filter(([file, digest]) => hash(file) !== digest).map(([file]) => file);
  report.measurement.sourcesHeldConstant = !changedSources.length;
  if (changedSources.length) {
    report.measurement.invalidReason = `Sources changed during run: ${changedSources.join(', ')}`;
    report.statistics = {};
  }
  for (const [file, digest] of sourceHashes) verify(`source fingerprint held constant: ${file}`, () => assert.equal(hash(file), digest, `Source changed during test: ${file}`));
}
if (process.env.FC_LIVE_REPORT) {
  assert(process.env.FC_LIVE_REPORT.startsWith('/'), 'FC_LIVE_REPORT must be absolute');
  writeFileSync(process.env.FC_LIVE_REPORT, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
if (report.failures.length) process.exitCode = 1;
