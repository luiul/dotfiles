#!/usr/bin/env node
/** Private Rex Pi TUI checks. No network, global config changes, or user-session input.
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
import { RexTestDriver } from './rex-test-driver.mjs';

assert(!process.versions.bun, 'Run this live harness with native Node');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidate = join(repo, 'pi/.pi/agent/extensions/filechanges.ts');
const current = join(homedir(), 'dotfiles/pi/.pi/agent/extensions/filechanges.ts');
const zen = join(homedir(), 'dotfiles/pi/.pi/agent/extensions/zen.ts');
const fixture = join(repo, 'scripts/fixtures/filechanges-live.ts');
// Managed Pi updates can leave install/current stale. Read the active release,
// never repair install links or change the running user's configuration.
const versionFile = join(homedir(), '.pi/agent/install/current-version');
const version = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : null;
const cli = process.env.FC_LIVE_PI_CLI ?? join(homedir(), '.pi/agent/install', version ? `releases/${version}` : 'current', 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
const baseline = process.env.FC_LIVE_BASELINE;
const repeats = Number(process.env.FC_LIVE_REPEATS ?? 3);
assert(Number.isInteger(repeats) && repeats >= 0 && repeats <= 10, 'FC_LIVE_REPEATS must be 0 through 10');
for (const file of [candidate, zen, fixture, cli]) assert(existsSync(file), `Missing ${file}`);
const root = mkdtempSync(join(homedir(), '.fc-live-'));
const owned = new Map();
const pids = new Set();
let driver;
const report = { runtime: process.execPath, cli, version, zen, backend: 'private Rex',
  comparability: 'same-run Rex variants only; not comparable with historic tmux startup measurements', checks: [], failures: [], skips: [], startup: {}, idle: [], exits: [], navigation: {},
  measurement: { repeats, pollingMs: 120, statistic: 'nearest-rank p95, descriptive only for small samples', startup: 'Rex target creation to first captured model/footer paint, excludes private server registration', pane: '100x32', tuiMode: 'fullscreen', liveZenInEveryVariant: true }, sources: {} };
const suiteDeadline = Date.now() + 12 * 60_000;
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
function events(host) {
  if (!existsSync(host.events)) return [];
  return readFileSync(host.events, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
function capture(host, ansi = false) {
  // Assertions use only the current viewport. Style probes use the VT redraw;
  // idle byte measurements still use Pi's original write log, not this capture.
  return driver.capture(host, ansi ? { format: 'vt', history: true } : {});
}
function styledPanel(host) { return panel(capture(host, true).replaceAll('\r\n', '\n').split('\n').slice(-host.rows).join('\n')); }
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
    assert(!driver.process(host).last_exit && alive(host.pid), `Pi exited before ${description}:\n${last}`);
    const list = events(host);
    assert(!list.some((e) => e.type === 'fixture-error'), JSON.stringify(list));
    if (predicate(last, list)) return last;
    await sleep(120);
  }
  throw new Error(`Timed out: ${description}\n${last}\nEvents: ${JSON.stringify(events(host))}`);
}
function input(host, text) { driver.text(host, text); }
function key(host, name) { driver.key(host, name.replace(/^C-/, 'ctrl+')); }
async function command(host, text) { key(host, 'C-u'); input(host, text); key(host, 'Enter'); await sleep(150); }
async function stable(host) {
  let previous = '';
  for (let i = 0; i < 40; i++) {
    const now = capture(host);
    failOnHostErrors(now);
    assert(!driver.process(host).last_exit && alive(host.pid), `Pi exited while settling:\n${now}`);
    if (now === previous) return now;
    previous = now;
    await sleep(150);
  }
  throw new Error('TUI failed to settle');
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function stop(host) {
  if (host.closed) return;
  // Keep the block until its target has exited. Rex's outer login PID is not Pi.
  // The driver owns identity-checked forced cleanup if graceful shutdown fails.
  if (host.pid && alive(host.pid)) {
    key(host, 'Escape');
    await sleep(40);
    key(host, 'C-u');
    key(host, 'C-d');
  }
  const until = Date.now() + 5000;
  let state = driver.process(host);
  while ((!state.last_exit || (host.pid && alive(host.pid))) && Date.now() < until) {
    await sleep(100);
    state = driver.process(host);
  }
  const retained = capture(host);
  // These captures are terminal frames. ansi.log remains the original write log.
  writeFileSync(join(host.area, 'exit.txt'), retained);
  writeFileSync(join(host.area, 'exit.ansi'), capture(host, true));
  report.exits.push({ label: host.label, mode: host.mode, pid: host.pid, lastExit: state.last_exit, retainedBytes: Buffer.byteLength(retained) });
  assert(state.last_exit && (!host.pid || !alive(host.pid)), `Pi failed to exit: ${host.pid}\n${retained}`);
  assert(retained.length > 0, 'Exit output was not retained');
  driver.close(host);
  host.closed = true;
  owned.delete(host.name);
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
async function start(label, extension, { dir, session, width = 100, height = 32, mode = 'fullscreen' } = {}) {
  const area = join(root, `host-${++sequence}`);
  mkdirSync(area);
  dir ??= join(area, 'files');
  mkdirSync(dir, { recursive: true });
  const config = join(area, 'agent');
  mkdirSync(config);
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ quietStartup: true, theme: 'dark', defaultProvider: 'fc-live', defaultModel: 'fixture', enableAnalytics: false, enableInstallTelemetry: false, cacheWarming: 'off', fullscreenCopyOnSelect: false, compaction: { enabled: false }, retry: { enabled: false } }));
  const host = { label, mode, name: `ag-fc-${process.pid}-${sequence}`, dir, events: join(area, 'events.jsonl'), log: join(area, 'ansi.log'), area };
  const env = { HOME: area, PATH: process.env.PATH, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8',
    PI_CODING_AGENT_DIR: config, PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', PI_OFFLINE: '1', PI_TRUE_COLOR: '1', PI_IMAGE_PROTOCOL: 'none',
    PI_PROGRAM_STATUS: '0', PI_TUI_WRITE_LOG: host.log, FC_LIVE_EVENTS: host.events, ...(extension ? { FC_LIVE_EXTENSION: extension } : {}) };
  const args = [process.execPath, cli, '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve', '--no-mcp', '--no-themes', '--thinking', 'off', '--provider', 'fc-live', '--model', 'fixture', '--tui-mode', mode, '--use-theme', 'dark', '--session-dir', join(dir, 'sessions'), '-e', zen, '--zen', '-e', fixture, ...(session ? ['--session', session] : [])];
  // The suite owns one private server and broker. Each host is an argv launch
  // with isolated config and HOME, never a GUI or an inherited model account.
  const t0 = performance.now();
  const wallStart = Date.now();
  Object.assign(host, driver.create({ name: host.name, command: args, cwd: dir, env, columns: width, rows: height }));
  owned.set(host.name, host);
  try {
    const pidDeadline = Math.min(Date.now() + 10_000, suiteDeadline);
    while (!(host.pid = driver.pid(host)) && Date.now() < pidDeadline) await sleep(100);
    assert(Number.isSafeInteger(host.pid) && host.pid > 1, `Target PID missing: ${host.name}`);
    pids.add(host.pid);
    const first = await wait(host, (text, list) => list.some((e) => e.type === 'ready') && /fixture|FC Live Fixture/.test(text) && /%\//.test(text), 'first interactive paint');
    host.startupMs = Math.round(performance.now() - t0);
    const ready = events(host).find((e) => e.type === 'ready');
    host.hookReadyMs = ready.at - wallStart;
    assert.equal(ready.mode, 'tui');
    assert.equal(ready.pid, host.pid, 'Driver PID must name the actual Pi target');
    host.session = ready.session;
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
    // Preserve a retained exit frame in the error before fixture cleanup.
    const retained = capture(host);
    try { await stop(host); } catch (cleanupError) { report.failures.push({ name: `stop ${label}`, error: String(cleanupError) }); }
    throw new Error(`${error.message}\nRetained output:\n${retained}`);
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
  check(`${host.mode}: static candidate Panel writes zero bytes in two 1.2-second idle slices`);
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
async function runList(mode) {
  const checkList = name => check(`${mode}: ${name}`);
  const verifyList = (name, fn) => verify(`${mode}: ${name}`, fn);
  const dir = join(root, `list-files-${mode}`);
  mkdirSync(dir);
  const session = seed(dir);
  const host = await start('seeded-list', candidate, { dir, session, mode });
  try {
    let text = await stable(host);
    assert(panel(text).includes('40 files') && panel(text).includes('34 more'));
    assert.equal((panel(text).match(/seed-\d+\.txt/g) ?? []).length, 6);
    checkList('40-file restored Session set stays compact in Panel');
    await idle(host, `${mode}: candidate seeded static Panel`);
    const settledBefore = events(host).filter((e) => e.type === 'settled').length;
    await command(host, '/filechanges');
    text = await wait(host, (screen) => screen.includes('seed-01.txt') && /^created\s+seed-/m.test(screen), '/filechanges List');
    verifyList('full List hides the persistent Panel', () => assert.equal(panel(text), ''));
    verifyList('List help/footer fits the real 100x32 viewport', () => assert(text.includes('Escape closes'), text));
    const seen = new Set();
    for (let i = 0; i < 7; i++) {
      for (const match of capture(host).matchAll(/seed-\d+\.txt/g)) seen.add(match[0]);
      input(host, '\x1b[6~');
      await sleep(180);
    }
    const pagingSeen = new Set(seen);
    verifyList('real /filechanges and PageDown expose all 40 files', () => assert.equal(pagingSeen.size, 40, `List page traversal missed files: ${[...pagingSeen].join(', ')}`));
    key(host, 'Home');
    await stable(host);
    for (let i = 0; i < 40; i++) {
      for (const match of capture(host).matchAll(/seed-\d+\.txt/g)) seen.add(match[0]);
      key(host, 'Down');
      await sleep(30);
    }
    verifyList('arrow-key List traversal exposes all 40 files', () => assert.equal(seen.size, 40, `Visible filenames: ${[...seen].join(', ')}`));
    key(host, 'End');
    text = await stable(host);
    verifyList('End exposes the final List file', () => assert(text.includes('seed-40.txt'), text));
    input(host, '\x1b[5~');
    text = await stable(host);
    verifyList('PageUp returns to the first List file', () => assert(text.includes('seed-01.txt'), text));
    key(host, 'Escape');
    text = await stable(host);
    verifyList('Escape restores the six-file cumulative Panel', () => {
      assert(panel(text).includes('40 files') && panel(text).includes('34 more'));
      assert.equal((panel(text).match(/seed-\d+\.txt/g) ?? []).length, 6);
    });
    await command(host, '/fc-live-draft');
    await wait(host, (screen) => /^created\s+seed-/m.test(screen), 'draft List opens');
    key(host, 'End');
    await stable(host);
    key(host, 'Escape');
    text = await wait(host, (_screen, list) => list.some((e) => e.type === 'draft-after'), 'draft List closes');
    verifyList('registered List handler preserves the real editor draft on Escape', () => {
      assert.equal(events(host).find((e) => e.type === 'draft-after').text, 'DRAFT keep this text');
      assert(text.includes('DRAFT keep this text'));
    });
    key(host, 'C-u');
    driver.resize(host, 40, 24);
    text = await wait(host, (screen) => panel(screen).includes('seed-01.txt'), '40-column Panel resize');
    assert(panel(text).includes('40 files'));
    const dark = styledPanel(host);
    await command(host, '/fc-live-theme light');
    await wait(host, (_screen, list) => list.some((e) => e.type === 'theme' && e.success), 'theme switch');
    await stable(host);
    const light = styledPanel(host);
    verifyList('40-column resize and real theme switch keep Panel visible', () => {
      assert.notEqual(light, dark, 'Panel ANSI colors did not change with theme');
      assert(panel(capture(host)).includes('seed-01.txt'));
    });
    await command(host, '/filechanges');
    await wait(host, (screen) => /^created\s+seed-/m.test(screen), 'narrow List');
    report.navigation[mode] = { observedBeforeFinalEnd: events(host).filter((e) => e.type === 'navigation'),
      sentPageDown: 7, reachedExtensionInputListener: events(host).filter((e) => e.type === 'navigation' && e.data === '\x1b[6~').length };
    key(host, 'End');
    text = await stable(host);
    verifyList('List End exposes the tail at 40 columns after theme switch', () => assert(text.includes('seed-40.txt'), text));
    key(host, 'Escape');
    await stable(host);
    assert.equal(events(host).filter((e) => e.type === 'settled').length, settledBefore, 'List or draft accidentally submitted a model prompt');
    checkList('List navigation and draft probe never submit a model prompt');
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
  if (repeats === 0) { report.skips.push('startup measurements: FC_LIVE_REPEATS=0'); console.log('SKIP startup measurements: FC_LIVE_REPEATS=0'); }
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
          (report.startup[`${name}/${count ? 'restored40' : 'empty0'}`] ??= []).push({ firstPaintMs: host.startupMs, hookReadyMs: host.hookReadyMs, ...host.resources });
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
  const registrationStart = performance.now();
  driver = await RexTestDriver.start({ deadlineMs: Math.max(1000, suiteDeadline - Date.now()) });
  report.measurement.privateServerRegistrationMs = Math.round(performance.now() - registrationStart);
  await scenario('prompt lifecycle, resume, reload and Clear', runBehavior);
  for (const mode of ['fullscreen', 'regular']) await scenario(`${mode}: List, draft, resize and theme`, () => runList(mode));
  await scenario('startup measurements', measureStartup);
} catch (error) {
  report.failures.push({ name: 'private Rex setup', error: String(error) });
  console.error(`FAIL private Rex setup: ${error.message}`);
} finally {
  for (const host of owned.values()) {
    try { await stop(host); } catch (error) { report.failures.push({ name: `stop ${host.label}`, error: String(error) }); }
  }
  let cleanupComplete = !driver;
  try { if (driver) { report.cleanup = await driver.stop(); cleanupComplete = true; } }
  catch (error) { report.failures.push({ name: 'private Rex cleanup', error: String(error) }); }
  verify('owned Pi processes exited', () => { for (const pid of pids) assert(!alive(pid), `Test-owned Pi process ${pid} leaked`); });
  verify('owned Rex server, broker and fixture removed', () => assert(cleanupComplete && (!driver || !existsSync(driver.root)), `Private fixture retained: ${driver?.root}`));
  if (cleanupComplete && [...pids].every(pid => !alive(pid))) rmSync(root, { recursive: true, force: true });
  else report.retainedRoot = root;
  verify('owned fixture directories removed', () => assert(!existsSync(root), `Fixture retained: ${root}`));
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
