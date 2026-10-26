#!/usr/bin/env node
/** Real Pi footer checks. No network, global config changes, or system clipboard writes.
 * Run after the candidate is ready: node scripts/test-status-bar-live.mjs
 * SB_LIVE_PI_CLI and SB_LIVE_CANDIDATE accept absolute file paths.
 * SB_LIVE_PROVIDER defaults to an isolated ai-model-router fixture (sb-live also works).
 * SB_LIVE_REPORT optionally writes the results to an absolute path.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

assert(!process.versions.bun, 'Run this live harness with Node, not Bun');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidate = process.env.SB_LIVE_CANDIDATE ?? join(repo, 'pi/.pi/agent/extensions/status-bar.ts');
const fixture = join(repo, 'scripts/fixtures/status-bar-live.ts');
const preload = join(repo, 'scripts/fixtures/status-bar-clipboard.cjs');
const cli = process.env.SB_LIVE_PI_CLI ?? join(homedir(), '.pi/agent/install/current/node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
const provider = process.env.SB_LIVE_PROVIDER ?? 'ai-model-router';
assert(['ai-model-router', 'sb-live'].includes(provider), 'Use only an isolated fixture provider');
for (const path of [candidate, fixture, preload, cli]) assert(existsSync(path), `Missing ${path}`);
const { visibleWidth } = await import(pathToFileURL(join(dirname(dirname(cli)), '../pi-tui/dist/index.js')).href);
const root = mkdtempSync(join(tmpdir(), 'sb-live-'));
const deadline = Date.now() + 8 * 60_000;
const owned = new Map();
const pids = new Set();
const hashes = new Map([candidate, fixture, preload].map((file) => [file, digest(file)]));
const report = { cli, candidate, provider, checks: [], failures: [], screens: [], sources: Object.fromEntries(hashes) };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
let sequence = 0;
function digest(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function run(binary, args, optional = false) {
  try { return execFileSync(binary, args, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { if (optional) return ''; throw new Error(`${binary} ${args.join(' ')}: ${error.stderr ?? error.message}`); }
}
function tmux(...args) { return run('tmux', args); }
function events(host) {
  if (!existsSync(host.events)) return [];
  // Ignore an incomplete final write, never discard earlier events.
  const text = readFileSync(host.events, 'utf8');
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
function capture(host) { return tmux('capture-pane', '-p', '-t', host.name); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function hostErrors(host, text) {
  assert(!/Extension error|Extension ".*" error:|Failed to load extension|Unhandled|uncaughtException|TypeError:|Error in render|exceeds terminal width/i.test(text), `Host error:\n${text}`);
  const list = events(host);
  for (const event of list) if (Number.isInteger(event.pid)) pids.add(event.pid);
  assert(!list.some((event) => ['fixture-error', 'clipboard-blocked'].includes(event.type)), JSON.stringify(list));
  return list;
}
async function wait(host, predicate, description, ms = 35_000) {
  const until = Math.min(Date.now() + ms, deadline);
  let last = '';
  while (Date.now() < until) {
    last = capture(host);
    const list = hostErrors(host, last);
    assert.equal(tmux('display-message', '-p', '-t', host.name, '#{pane_dead}').trim(), '0', `Pi host exited:\n${last}`);
    if (predicate(last, list)) return last;
    await sleep(100);
  }
  throw new Error(`Timed out: ${description}\n${last}\nEvents: ${JSON.stringify(events(host))}`);
}
function key(host, name) { tmux('send-keys', '-t', host.name, name); }
async function command(host, text) {
  key(host, 'C-u');
  tmux('send-keys', '-t', host.name, '-l', text);
  key(host, 'Enter');
  await sleep(120);
}
function current(host) {
  return events(host).filter((event) => ['ready', 'settled', 'snapshot', 'model'].includes(event.type)).at(-1);
}
async function snapshot(host) {
  const count = events(host).filter((e) => e.type === 'snapshot').length;
  await command(host, '/sb-live-snapshot');
  await wait(host, (_screen, list) => list.filter((e) => e.type === 'snapshot').length > count, 'snapshot fence');
  return current(host);
}
function check(name, details) { report.checks.push({ name, ...(details ? { details } : {}) }); console.log(`PASS ${name}`); }
async function scenario(name, fn) {
  try { await fn(); }
  catch (error) { report.failures.push({ name, error: String(error).slice(0, 6000) }); console.error(`FAIL ${name}: ${error.message}`); }
}
function seed(area, cwd, { unknown = false } = {}) {
  const timestamp = new Date().toISOString();
  const uuid = randomUUID();
  const usage = { input: 30000, output: 1000, cacheRead: 40000, cacheWrite: 0, totalTokens: 71000,
    cost: { input: 0.03, output: 0.002, cacheRead: 0.004, cacheWrite: 0, total: 0.036 } };
  const records = [
    { type: 'session', version: 3, id: uuid, timestamp, cwd },
    { type: 'model_change', id: 'm0000001', parentId: null, timestamp, provider, modelId: 'fixture' },
    { type: 'message', id: 'u0000001', parentId: 'm0000001', timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'SB_SEEDED' }], timestamp: Date.now() } },
    { type: 'message', id: 'a0000001', parentId: 'u0000001', timestamp,
      message: { role: 'assistant', api: 'sb-live-stream', provider, model: 'fixture', timestamp: Date.now(),
        content: [{ type: 'text', text: 'SB_SEED_DONE' }], stopReason: 'stop', usage } },
  ];
  if (unknown) records.push({ type: 'compaction', id: 'c0000001', parentId: 'a0000001', timestamp,
    summary: 'Fixture summary', firstKeptEntryId: 'c0000001', tokensBefore: 71000 });
  const file = join(area, 'sessions', `seed_${uuid}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return { file, uuid };
}
async function start(mode, { cwd = repo, width = 160, seeded = true, unknown = false, compact = true } = {}) {
  assert(Date.now() < deadline - 35_000, 'Suite deadline reached');
  const area = join(root, `host-${++sequence}`);
  const home = join(area, 'home');
  const config = join(home, '.pi/agent');
  mkdirSync(config, { recursive: true });
  const settings = { quietStartup: true, theme: 'dark', defaultProvider: provider, defaultModel: 'fixture',
    compaction: { enabled: compact, reserveTokens: 16384 }, retry: { enabled: false }, cacheWarming: 'off',
    enableInstallTelemetry: false, enableAnalytics: false, fullscreenCopyOnSelect: false };
  writeFileSync(join(config, 'settings.json'), JSON.stringify(settings));
  const initial = seeded ? seed(area, cwd, { unknown }) : undefined;
  const host = { name: `ag-sb-${process.pid}-${sequence}`, mode, width, cwd, area,
    events: join(area, 'events.jsonl'), log: join(area, 'ansi.log'), pid: undefined, initial };
  const env = { HOME: home, PATH: process.env.PATH, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8',
    PI_CODING_AGENT_DIR: config, PI_SKIP_VERSION_CHECK: '1', PI_OFFLINE: '1', PI_TRUE_COLOR: '1', PI_IMAGE_PROTOCOL: 'none',
    PI_TUI_WRITE_LOG: host.log, SB_LIVE_EVENTS: host.events, SB_LIVE_PROVIDER: provider,
    NODE_OPTIONS: `--require ${JSON.stringify(preload)}` };
  // env -i also drops SSH and PI_CLIPBOARD_OSC52 markers. The preload blocks OSC 52 anyway.
  const args = [process.execPath, cli, '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates',
    '--no-context-files', '--no-approve', '--no-mcp', '--no-themes', '--no-tools', '--thinking', 'off',
    '--provider', provider, '--model', 'fixture', '--tui-mode', mode, '--use-theme', 'dark',
    '--session-dir', join(area, 'sessions'), '-e', fixture, '-e', candidate,
    ...(initial ? ['--session', initial.file] : [])];
  const launch = `cd ${quote(cwd)} && exec env -i ${Object.entries(env).map(([k, v]) => quote(`${k}=${v}`)).join(' ')} ${args.map(quote).join(' ')}`;
  tmux('new-session', '-d', '-s', host.name, '-x', String(width), '-y', '32', '/bin/sleep 480');
  owned.set(host.name, host);
  try {
    run('reap-strays', ['--register-tmux', host.name, '--owner', String(process.pid), '--deadline', String(Math.ceil(deadline / 1000))]);
    tmux('set-option', '-t', host.name, 'remain-on-exit', 'on');
    tmux('respawn-pane', '-k', '-t', host.name, launch);
    // Record the exact exec'd pane PID even when extension loading fails before ready.
    host.pid = Number(tmux('display-message', '-p', '-t', host.name, '#{pane_pid}').trim());
    pids.add(host.pid);
    await wait(host, (text, list) => list.some((e) => e.type === 'ready') && /\bsession\b/.test(text) && (!seeded || cwd !== repo || text.includes('worktree improve-status-bar')), 'first custom footer paint');
    const list = events(host);
    const ready = list.find((e) => e.type === 'ready');
    assert.equal(ready.pid, host.pid, 'Pane PID must be the actual Pi host');
    assert.equal(ready.mode, 'tui');
    assert.equal(ready.provider, provider);
    assert.equal(ready.cwd, cwd);
    assert(list.some((e) => e.type === 'clipboard-preload') && list.some((e) => e.type === 'clipboard-safe'));
    assert.deepEqual([...ready.commands].sort(), ['sb-live-model', 'sb-live-snapshot', 'session-ref', 'statusbar'].sort(), 'Inherited extension commands');
    if (initial) assert.equal(ready.uuid, initial.uuid);
    return host;
  } catch (error) { await stop(host); throw error; }
}
async function stop(host) {
  if (!owned.has(host.name)) return;
  run('tmux', ['send-keys', '-t', host.name, 'Escape'], true);
  run('tmux', ['send-keys', '-t', host.name, 'C-u', 'C-d'], true);
  const until = Date.now() + 2500;
  while (host.pid && alive(host.pid) && Date.now() < until) await sleep(100);
  run('tmux', ['kill-session', '-t', host.name], true);
  if (host.pid && alive(host.pid)) {
    try { process.kill(host.pid, 'SIGTERM'); } catch {}
    await sleep(300);
    if (alive(host.pid)) { try { process.kill(host.pid, 'SIGKILL'); } catch {} }
  }
  const end = Date.now() + 1500;
  while (host.pid && alive(host.pid) && Date.now() < end) await sleep(100);
  owned.delete(host.name);
}
function footer(text, width) {
  const rows = text.split('\n').map((line) => line.trimEnd());
  const last = rows.findLastIndex((line) => /^\s*session(?:\s|$)/i.test(line) || (width < 44 && /^[0-9a-f]{8}-[0-9a-f-]{27}\s*$/i.test(line)));
  assert(last >= 0, `Missing session row:\n${text}`);
  const count = width >= 80 ? 3 : 4;
  const lines = rows.slice(last - count + 1, last + 1);
  assert.equal(lines.length, count);
  assert(lines.every((line) => line.trim()), `Footer has blank or missing rows:\n${lines.join('\n')}`);
  assert(rows.slice(last + 1).every((line) => !line.trim()), `Session row is not the final painted row:\n${text}`);
  for (const line of lines) assert(visibleWidth(line) <= width, `Footer wraps at ${width}: ${line}`);
  return lines;
}
function assertFooter(host, text, { working = false, context = 'known', identity = true, compact = true } = {}) {
  const lines = footer(text, host.width);
  const full = lines.join('\n');
  const state = current(host);
  if (host.width >= 44) {
    assert(lines.at(-1).includes(`session ${state.uuid}`), `Full session UUID missing at ${host.width}: ${lines.at(-1)}`);
  } else if (host.width >= 36) {
    assert.equal(lines.at(-1).trim(), state.uuid, '36-column UUID must remain complete');
  }
  if (host.width >= 60) {
    assert(full.includes('GPT-6.1 Sol'), `Friendly model missing:\n${full}`);
    assert(/GPT-6\.1 Sol\s+(?:[|·]\s*)?(?:provider\s+)?\[?(?:ai-model-router|sb-live)\b/.test(full), `Provider must follow model directly:\n${full}`);
  }
  if (identity && host.width >= 80) {
    assert(full.includes('dotfiles'), `Repository identity missing:\n${full}`);
    assert(/worktree\s+improve-status-bar(?:\/dotfiles)?\b/.test(full), `Worktree identity missing:\n${full}`);
    assert(/branch\s+improve-status-bar\b/.test(full), `Branch identity missing:\n${full}`);
  }
  if (host.width >= 60) {
    if (context === 'known') {
      assert(/context\b/.test(full), `Context missing:\n${full}`);
      assert(!/context (unknown|unavailable)/.test(full), `Known context lost:\n${full}`);
      assert(full.includes(compact ? 'until compact' : 'auto compact off'), `Compaction explanation missing:\n${full}`);
    } else assert(full.includes(`context ${context}`), `Context state missing:\n${full}`);
  }
  assert.equal(/\bworking\s+\d+(?:s|m|h|d)/.test(full), working, `Working timer state is wrong:\n${full}`);
  assert(!/\b(?:last|elapsed)\s+\d+(?:s|m|h|d)/.test(full), `Settled elapsed time leaked:\n${full}`);
  report.screens.push({ mode: host.mode, width: host.width, context, working, rows: lines });
  return lines;
}
async function resize(host, width, options) {
  host.width = width;
  tmux('resize-window', '-t', host.name, '-x', String(width), '-y', '32');
  // A complete repaint can follow the first width signal. Require two matching captures.
  let previous = '';
  const text = await wait(host, (screen) => {
    let lines;
    try { lines = footer(screen, width); } catch { previous = ''; return false; }
    const now = lines.join('\n');
    const stable = now === previous;
    previous = now;
    return stable;
  }, `${width}-column footer`);
  assertFooter(host, text, options);
  check(`${host.mode}: ${width}-column footer fits with ${width >= 80 ? 3 : 4} rows`);
}
async function copy(host, expected) {
  const before = events(host).filter((e) => e.type === 'clipboard').length;
  await command(host, '/session-ref');
  await snapshot(host);
  const copies = events(host).filter((e) => e.type === 'clipboard');
  assert.equal(copies.length, before + (expected ? 1 : 0), 'Unexpected clipboard write count');
  if (!expected) return;
  const text = copies.at(-1).text;
  const state = current(host);
  assert(state.persisted && existsSync(state.session), 'Clipboard reference must use a real persisted file');
  for (const value of [state.uuid, state.session, state.cwd, state.leaf]) assert(text.includes(value), `Copied reference missing ${value}:\n${text}`);
  assert(text.includes(`Current branch leaf: ${state.leaf}`), `Reference must pin the captured branch leaf:\n${text}`);
  const records = readFileSync(state.session, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records[0].id, state.uuid);
  const entries = new Map(records.slice(1).map((entry) => [entry.id, entry]));
  const visited = new Set();
  for (let leaf = state.leaf; leaf !== null; leaf = entries.get(leaf).parentId) {
    assert(entries.has(leaf) && !visited.has(leaf), `Captured leaf has a broken parentId chain: ${leaf}`);
    visited.add(leaf);
  }
  assert(visited.size > 0, 'Copied reference has no captured branch');
  assert(/read[ -]only|Read the transcript without changing it/i.test(text), `Reference must prohibit transcript writes:\n${text}`);
  assert(/Do not resume this session/.test(text), `Reference must prohibit resume:\n${text}`);
  assert(!/\bpi\s+(?:--session|--resume|--continue|-r|-c)\b/i.test(text), `Reference contains resume command:\n${text}`);
  assert(!events(host).some((e) => e.type === 'clipboard-blocked'), 'Unsafe clipboard route attempted');
  check(`${host.mode}: actual /session-ref copied a persisted read-only reference to the fake native backend`);
}
async function lifecycle(mode) {
  const host = await start(mode);
  try {
    const first = capture(host);
    const startupRows = assertFooter(host, first).join('\n');
    for (const value of ['in 30k', 'out 1.0k', 'cache 40k', '$0.036']) {
      assert(startupRows.includes(value), `Seeded usage or cost missing from footer: ${value}\n${startupRows}`);
    }
    assert(current(host).usage?.tokens > 70000, 'Seed usage did not reach the real context accountant');
    check(`${mode}: startup paints model, provider, repository, worktree, branch, context and full UUID`);
    await copy(host, true);
    const savedFile = current(host).session;
    const unavailableFile = `${savedFile}.unavailable`;
    renameSync(savedFile, unavailableFile);
    try {
      await copy(host, false);
      assert.equal(current(host).persisted, false);
      if (mode === 'regular') assert(capture(host).includes('No saved transcript is available for this session.'), 'Missing saved transcript warning');
      check(`${mode}: /session-ref refuses a file that no longer exists`);
    } finally { renameSync(unavailableFile, savedFile); }
    for (const width of [100, 80, 60, 44, 36, 160]) await resize(host, width);
    const settledCount = events(host).filter((e) => e.type === 'settled').length;
    await command(host, 'SB_LIVE_TURN');
    const active = await wait(host, (screen, list) => list.some((e) => e.type === 'response-start') && /working\s+\d+s/.test(screen), 'active timer', 4000);
    assertFooter(host, active, { working: true });
    await wait(host, (_screen, list) => list.filter((e) => e.type === 'settled').length > settledCount, 'deterministic turn settles');
    const settled = await wait(host, (screen) => !/working\s+\d+(?:s|m|h|d)/.test(footer(screen, host.width).join('\n')), 'settled timer disappears');
    assertFooter(host, settled);
    const records = readFileSync(current(host).session, 'utf8').trim().split('\n').map(JSON.parse);
    const usage = records.filter((e) => e.type === 'message' && e.message.role === 'assistant').at(-1).message.usage;
    assert.deepEqual([usage.input, usage.output, usage.cacheRead, usage.cost.total], [30000, 1000, 40000, 0.036]);
    check(`${mode}: real streamed turn shows working, records known usage and hides the timer on settlement`);
    const old = current(host).uuid;
    const readyCount = events(host).filter((e) => e.type === 'ready').length;
    await command(host, '/clone');
    await wait(host, (_screen, list) => list.filter((e) => e.type === 'ready').length > readyCount, 'actual /clone session lifecycle');
    const cloned = await snapshot(host);
    assert.notEqual(cloned.uuid, old);
    assert(cloned.persisted);
    const clonedText = await wait(host, (screen) => footer(screen, host.width).at(-1).includes(cloned.uuid), 'cloned UUID footer');
    assertFooter(host, clonedText);
    await copy(host, true);
    check(`${mode}: /clone changes the UUID and the copied session file`);
    await command(host, '/statusbar');
    await snapshot(host);
    assert(!capture(host).includes(`session ${cloned.uuid}`), 'Toggle did not remove custom footer');
    await copy(host, true);
    check(`${mode}: /session-ref still works with the enhanced footer disabled`);
    await command(host, '/statusbar');
    await wait(host, (screen) => screen.includes(`session ${cloned.uuid}`), 'footer enabled again');
  } finally { await stop(host); }
}
async function fresh(mode) {
  const host = await start(mode, { width: 44, seeded: false });
  try {
    assertFooter(host, capture(host), { context: 'known' });
    assert.equal(current(host).persisted, false, 'Fresh session unexpectedly persisted');
    await copy(host, false);
    check(`${mode}: fresh 44-column startup keeps the UUID and refuses an unpersisted session reference`);
    await resize(host, 160);
    await command(host, '/sb-live-model unavailable');
    await wait(host, (screen, list) => list.some((e) => e.type === 'model' && e.model === 'unavailable') && screen.includes('context unavailable'), 'unavailable context');
    assertFooter(host, capture(host), { context: 'unavailable' });
    check(`${mode}: missing model context limits show context unavailable`);
  } finally { await stop(host); }
}
async function fallback(mode, compact) {
  const cwd = join(root, `nongit-${mode}-${compact}`);
  mkdirSync(cwd);
  const host = await start(mode, { cwd, unknown: compact, compact });
  try {
    assert.equal(run('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], true), '', 'Fallback fixture is unexpectedly a Git repository');
    const options = { context: compact ? 'unknown' : 'known', identity: false, compact };
    const text = capture(host);
    assertFooter(host, text, options);
    assert(text.includes(cwd.split('/').at(-1)), 'Non-Git cwd fallback missing');
    assert(!/worktree\s+improve-status-bar|branch\s+improve-status-bar/.test(footer(text, 160).join('\n')), 'Non-Git host inherited worktree state');
    await resize(host, 60, options);
    await resize(host, 160, options);
    await copy(host, true);
    check(`${mode}: non-Git identity and ${compact ? 'post-compaction unknown context' : 'auto compact off'} survive resize`);
  } finally { await stop(host); }
}
try {
  for (const mode of ['regular', 'fullscreen']) {
    await scenario(`${mode} footer lifecycle`, () => lifecycle(mode));
    await scenario(`${mode} fresh and unavailable context`, () => fresh(mode));
    await scenario(`${mode} unknown context and cwd fallback`, () => fallback(mode, true));
    await scenario(`${mode} auto compaction off`, () => fallback(mode, false));
  }
} finally {
  for (const host of owned.values()) await stop(host);
  for (const pid of pids) if (alive(pid)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  await sleep(300);
  await scenario('recorded Pi host PIDs exited', async () => {
    for (const pid of pids) assert(!alive(pid), `Test-owned Pi host ${pid} leaked`);
    check('recorded Pi host PIDs exited');
  });
  await scenario('owned tmux sessions removed', async () => {
    const names = run('tmux', ['list-sessions', '-F', '#{session_name}'], true).split('\n');
    assert(!names.some((name) => name.startsWith(`ag-sb-${process.pid}-`)));
    check('owned tmux sessions removed');
  });
  await scenario('source files unchanged during the run', async () => {
    for (const [file, expected] of hashes) assert.equal(digest(file), expected, `Source changed: ${file}`);
    check('source files unchanged during the run');
  });
  rmSync(root, { recursive: true, force: true });
  await scenario('fixture directories removed', async () => { assert(!existsSync(root)); check('fixture directories removed'); });
  // Local dry-run diagnostics only. Do not reap unrelated sessions or processes.
  const audit = run('reap-strays', ['--dry-run', '--report'], true);
  report.straysAudit = audit.slice(-4000);
}
if (process.env.SB_LIVE_REPORT) {
  assert(process.env.SB_LIVE_REPORT.startsWith('/'), 'SB_LIVE_REPORT must be absolute');
  writeFileSync(process.env.SB_LIVE_REPORT, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
if (report.failures.length) process.exitCode = 1;
