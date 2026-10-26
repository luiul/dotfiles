#!/usr/bin/env node
/** Isolated Pi 1.4.0 streaming TUI checks. No network or user session/config writes.
 * ZEN_LIVE_EXTENSION=/absolute/baseline.ts ZEN_LIVE_MEASURE_ONLY=1 node scripts/test-zen-live.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidate = resolve(process.env.ZEN_LIVE_EXTENSION ?? join(repo, 'pi/.pi/agent/extensions/zen.ts'));
const fixture = join(repo, 'scripts/fixtures/zen-live.ts');
const install = join(homedir(), '.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent');
const cli = process.env.ZEN_LIVE_PI_CLI ?? join(install, 'dist/cli.js');
const toolComponent = join(install, 'dist/modes/interactive/components/tool-execution.js');
const measureOnly = process.env.ZEN_LIVE_MEASURE_ONLY === '1';
for (const path of [candidate, fixture, cli, toolComponent]) assert(existsSync(path), `Missing ${path}`);
assert.equal(JSON.parse(readFileSync(join(install, 'package.json'), 'utf8')).version, '1.4.0');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'zen-live-')));
const owned = new Map(), checks = [], metrics = [], observations = [];
const deadline = performance.now() + 180_000;
const testStarted = performance.now();
const mono = () => Number(process.hrtime.bigint()) / 1e6;
const q = (v) => `'${String(v).replaceAll("'", "'\\''")}'`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let sequence = 0;
function check(name, fn, candidateOnly = false) {
  if (candidateOnly && measureOnly) {
    try { fn(); observations.push({ name, pass: true }); }
    catch (error) { observations.push({ name, pass: false, error: error.message }); }
    return;
  }
  fn(); checks.push(name); console.log(`PASS ${name}`);
}
function run(file, args, optional = false) {
  try { return execFileSync(file, args, { encoding: 'utf8', timeout: 6000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { if (optional) return ''; throw new Error(`${file}: ${error.stderr ?? error.message}`); }
}
const tmux = (...args) => run('tmux', args);
const events = (h) => existsSync(h.events) ? readFileSync(h.events, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
const raw = (h) => existsSync(h.raw) ? readFileSync(h.raw, 'utf8') : '';
const capture = (h) => tmux('capture-pane', '-p', '-t', h.name);
function inspect(h) {
  const screen = capture(h), list = events(h);
  assert(!/Extension error|Failed to load extension|TypeError:|Error in render|exceeds terminal width/.test(screen), screen);
  assert(!list.some((e) => e.type === 'fixture-error'), JSON.stringify(list.filter((e) => e.type === 'fixture-error')));
  h.samples.push({ mono: mono(), screen });
  return { screen, list };
}
async function wait(h, predicate, label, timeout = 12_000) {
  const until = Math.min(performance.now() + timeout, deadline);
  let state;
  while (performance.now() < until) {
    state = inspect(h); if (predicate(state.screen, state.list)) return state;
    await sleep(45);
  }
  throw new Error(`Timed out: ${label}\n${state?.screen}\n${JSON.stringify(state?.list.slice(-6))}`);
}
async function send(h, text) {
  const sent = mono(); tmux('send-keys', '-t', h.name, 'C-u');
  tmux('send-keys', '-t', h.name, '-l', text); tmux('send-keys', '-t', h.name, 'Enter');
  return sent;
}
async function command(h, text) {
  const before = events(h).filter((e) => e.type === 'command').length;
  await send(h, text);
  await wait(h, (_s, list) => list.filter((e) => e.type === 'command').length > before, text);
}
function compact(frames) {
  assert(frames.length > 0, 'Actual host component render instrumentation must observe frames');
  for (const frame of frames) {
    assert.equal(frame.lines.length, 2, `${frame.tool} ${frame.id} ${frame.width}: expected separator and one row: ${JSON.stringify(frame.lines)}`);
    assert.equal(frame.lines[0], '', 'Native separator remains blank');
    if (frame.partial) assert(!frame.lines.join('\n').includes('ZEN_PARTIAL_SECRET'), 'Collapsed component leaked partial output');
    assert(frame.lines.every((line) => Array.from(line).length <= frame.width), 'ASCII fixture row exceeds terminal width');
  }
}
function descendants(pid) {
  const rows = run('ps', ['-axo', 'pid=,ppid='], true).trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
  const found = new Set([pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [child, parent] of rows) if (found.has(parent) && !found.has(child)) { found.add(child); changed = true; }
  }
  return [...found].filter(Number.isFinite);
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function stop(h) {
  h.pid ??= events(h).find((e) => e.type === 'ready')?.pid ?? Number(run('tmux', ['display-message', '-p', '-t', h.name, '#{pane_pid}'], true).trim());
  const children = h.pid ? descendants(h.pid) : [];
  run('tmux', ['send-keys', '-t', h.name, 'Escape'], true); await sleep(80);
  run('tmux', ['send-keys', '-t', h.name, 'C-u', 'C-d'], true);
  const until = performance.now() + 1800;
  while (h.pid && alive(h.pid) && performance.now() < until) await sleep(60);
  run('tmux', ['kill-session', '-t', h.name], true);
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const pid of children.reverse()) if (alive(pid)) { try { process.kill(pid, signal); } catch {} }
    await sleep(80);
  }
  h.children = [...new Set([...(h.children ?? []), ...children])];
  assert(!h.children.some(alive), `Owned process remains: ${h.children.filter(alive)}`);
}
async function start(mode) {
  const area = join(root, `host-${++sequence}`); mkdirSync(area);
  const agent = join(area, 'agent'); mkdirSync(agent);
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({ quietStartup: true, theme: 'dark', defaultProvider: 'zen-live', defaultModel: 'fixture',
    compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off', shellPath: '/bin/bash' }));
  const config = join(area, 'zen.json'); writeFileSync(config, '{"filter":true}\n');
  writeFileSync(join(area, 'shell-case.sh'), '#!/bin/bash\n/bin/sleep 0.3\nprintf "ZEN_PARTIAL_SECRET_BASH_ONE\\n"\n/bin/sleep 0.3\nprintf "ZEN_PARTIAL_SECRET_BASH_TWO\\n"\n/bin/sleep 0.3\n');
  writeFileSync(join(area, 'shell-interact.sh'), '#!/bin/bash\nprintf "ZEN_PARTIAL_SECRET_ONE\\n"\n/bin/sleep 0.8\nprintf "ZEN_PARTIAL_SECRET_TWO\\n"\n/bin/sleep 0.8\nprintf "ZEN_PARTIAL_SECRET_THREE\\n"\n/bin/sleep 0.8\n');
  writeFileSync(join(area, 'shell-abort.sh'), '#!/bin/bash\nprintf "bounded abort fixture\\nZEN_PARTIAL_SECRET_ABORT\\n"\n/bin/sleep 4\n');
  writeFileSync(join(area, 'read-case.txt'), 'ZEN_READ_SECRET_ONE\nZEN_READ_SECRET_TWO\n');
  const h = { name: `ag-zen-${process.pid}-${sequence}`, area, mode, width: 120, config, events: join(area, 'events.jsonl'), raw: join(area, 'ansi.log'), samples: [] };
  const env = { HOME: homedir(), PATH: process.env.PATH, TERM: 'xterm-256color', LANG: 'en_US.UTF-8', SHELL: '/bin/bash',
    PI_CODING_AGENT_DIR: agent, PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', PI_OFFLINE: '1', PI_IMAGE_PROTOCOL: 'none',
    PI_TUI_WRITE_LOG: h.raw, ZEN_LIVE_EVENTS: h.events, ZEN_LIVE_EXTENSION: candidate, ZEN_LIVE_CONFIG: config, ZEN_LIVE_TOOL_COMPONENT: toolComponent };
  const args = [cli, '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve', '--no-mcp', '--no-themes',
    '--thinking', 'off', '--provider', 'zen-live', '--model', 'fixture', '--tui-mode', mode, '--use-theme', 'dark', '--session-dir', join(area, 'sessions'), '-e', fixture];
  const launch = `cd ${q(area)} && exec env -i ${Object.entries(env).map(([k, v]) => q(`${k}=${v}`)).join(' ')} ${[process.execPath, ...args].map(q).join(' ')}`;
  h.launch = mono();
  tmux('new-session', '-d', '-s', h.name, '-x', String(h.width), '-y', '36', '/bin/sleep 180'); owned.set(h.name, h);
  run('reap-strays', ['--register-tmux', h.name, '--owner', String(process.pid), '--deadline', String(Math.ceil(Date.now() / 1000 + 180))]);
  tmux('respawn-pane', '-k', '-t', h.name, launch);
  await wait(h, (screen, list) => list.some((e) => e.type === 'ready') && /fixture/.test(screen), `${mode} startup`);
  h.pid = events(h).find((e) => e.type === 'ready').pid;
  const ready = events(h).find((e) => e.type === 'ready');
  const firstPaint = events(h).find((e) => e.type === 'write' && e.mono >= ready.mono);
  metrics.push({ mode, phase: 'startup', launchToReadyMs: ready.mono - h.launch, readyToPaintMs: firstPaint?.mono - ready.mono });
  check(`${mode}: isolated real TUI ready`, () => { assert.equal(ready.mode, 'tui'); assert(ready.session.startsWith(h.area)); });
  return h;
}
async function turn(h, scenario, { interact = false, abort = false } = {}) {
  const offset = raw(h).length, eventOffset = events(h).length, sampleOffset = h.samples.length;
  const settled = events(h).filter((e) => e.type === 'settled').length;
  const sent = await send(h, `ZEN_${scenario}`);
  const begun = await wait(h, (_s, list) => list.slice(eventOffset).some((e) => e.type === 'call-start'), `${scenario} call start`);
  const call = begun.list.slice(eventOffset).find((e) => e.type === 'call-start');
  await wait(h, (_s, list) => list.some((e) => e.type === 'tool-start' && e.id === call.id), `${scenario} tool execution`);
  let collapseOffset;
  if (interact) {
    await wait(h, (_s, list) => list.some((e) => (e.type === 'partial' || e.type === 'component-result' && e.partial) && e.id === call.id), 'partial ready');
    check(`${h.mode}/${scenario}: partial output stays hidden until expansion`, () => assert(!raw(h).slice(offset).includes('ZEN_PARTIAL_SECRET')), true);
    tmux('send-keys', '-t', h.name, 'C-o');
    await wait(h, (screen, list) => screen.includes('ZEN_PARTIAL_SECRET_ONE') && list.some((e) => e.type === 'frame' && e.id === call.id && e.expanded), 'expand live partial');
    await wait(h, (screen) => screen.includes('ZEN_PARTIAL_SECRET_TWO'), 'next partial while expanded');
    check(`${h.mode}: expanded running tool receives next live output`, () => assert(raw(h).slice(offset).includes('ZEN_PARTIAL_SECRET_TWO')));
    tmux('send-keys', '-t', h.name, 'C-o');
    await wait(h, (_s, list) => list.filter((e) => e.type === 'frame' && e.id === call.id).at(-1)?.expanded === false, 'collapse running tool');
    collapseOffset = raw(h).length;
  }
  if (abort) {
    await wait(h, (_s, list) => list.some((e) => (e.type === 'component-result' && e.partial || e.type === 'partial') && e.id === call.id), 'abort after partial');
    h.children = [...new Set([...(h.children ?? []), ...descendants(h.pid)])];
    tmux('send-keys', '-t', h.name, 'Escape');
  }
  await wait(h, (_s, list) => list.filter((e) => e.type === 'settled').length > settled, `${scenario} settlement`);
  const list = events(h).slice(eventOffset), frames = list.filter((e) => e.type === 'frame' && e.id === call.id);
  check(`${h.mode}/${h.width}/${scenario}: empty, progressive and full arguments sampled`, () => {
    assert(list.some((e) => e.type === 'args-progress')); assert(list.some((e) => e.type === 'args-full'));
    assert(frames.some((e) => !e.argsComplete)); assert(frames.some((e) => e.argsComplete));
    const progressing = list.find((e) => e.type === 'args-progress'), full = list.find((e) => e.type === 'args-full'), ended = list.find((e) => e.type === 'call-end');
    assert(frames.some((e) => e.mono < progressing.mono), 'Empty args frame sampled');
    assert(frames.some((e) => e.mono >= progressing.mono && e.mono < full.mono), 'Progressive args frame sampled');
    assert(frames.some((e) => e.mono >= full.mono && e.mono < ended.mono), 'Full args frame sampled before execution');
    assert(h.samples.length - sampleOffset >= 3, 'Repeated real pane captures');
  });
  if (interact) check(`${h.mode}/${scenario}: later partial output stays hidden after collapse`, () => {
    assert(!raw(h).slice(collapseOffset).includes('ZEN_PARTIAL_SECRET_THREE'));
  }, true);
  check(`${h.mode}/${h.width}/${scenario}: compact row at start, execution, partial and final paint`, () => compact(frames.filter((f) => !f.expanded)), true);
  const final = frames.find((f) => !f.partial), end = list.find((e) => e.type === 'tool-end' && e.id === call.id);
  if (!interact) check(`${h.mode}/${h.width}/${scenario}: no partial output in raw ANSI`, () => {
    // An aborted bash result includes captured stdout as its final error summary. That final suffix is allowed.
    const beforeFinal = abort ? list.filter((e) => e.type === 'write' && e.mono < end.mono).map((e) => e.data).join('') : raw(h).slice(offset);
    assert(!beforeFinal.includes('ZEN_PARTIAL_SECRET'), 'Partial marker appeared in PI_TUI_WRITE_LOG before completion');
  }, true);
  check(`${h.mode}/${h.width}/${scenario}: final status present in first completion paint`, () => {
    assert(final, 'Missing final frame');
    assert.match(final.lines[1], scenario === 'FAIL' || abort ? /✗/ : /✓/);
    assert(final.mono - end.mono < 200, `Completion paint latency ${final.mono - end.mono}ms`);
    const completionWrites = list.filter((e) => e.type === 'write' && e.mono >= end.mono);
    assert(completionWrites.some((e) => /[✓✗]/.test(e.data) && e.mono - end.mono < 200), 'Status missing from immediate terminal write');
  }, true);
  check(`${h.mode}/${h.width}/${scenario}: actual tool result and settlement`, () => {
    assert(end); assert.equal(end.error, scenario === 'FAIL' || abort);
    assert.equal(list.find((e) => e.type === 'settled').aborted, abort);
  });
  const first = frames[0], toolStart = list.find((e) => e.type === 'tool-start'), running = frames.find((f) => f.started);
  const writes = list.filter((e) => e.type === 'write');
  metrics.push({ mode: h.mode, width: h.width, scenario, promptToFirstPaintMs: writes[0]?.mono - sent, promptToRowMs: first?.mono - sent,
    callToRowMs: first?.mono - call.mono, toolStartToRowMs: running?.mono - toolStart?.mono,
    completionToRowMs: final?.mono - end?.mono, streamingMs: end?.mono - call.mono,
    ansiBytes: Buffer.byteLength(raw(h).slice(offset)), terminalWrites: writes.length,
    maxCollapsedRows: Math.max(...frames.filter((f) => !f.expanded).map((f) => f.lines.length)) });
  h.lastId = call.id;
  return call.id;
}
async function resize(h, width) {
  h.width = width; const before = events(h).length;
  tmux('resize-window', '-t', h.name, '-x', String(width), '-y', '36');
  await wait(h, (_s, list) => list.slice(before).some((e) => e.type === 'frame' && e.width === width), `resize ${width}`);
  check(`${h.mode}: existing compact blocks resize to ${width}`, () => compact(events(h).slice(before).filter((e) => e.type === 'frame' && !e.expanded)), true);
}
async function toggles(h) {
  tmux('send-keys', '-t', h.name, 'C-o');
  await wait(h, (_s, list) => list.filter((e) => e.type === 'frame' && e.id === h.lastId).at(-1)?.expanded === true, 'Ctrl+O existing blocks');
  check(`${h.mode}: Ctrl+O exposes native multiline calls and read output`, () => {
    assert(raw(h).includes('NATIVE_CALL')); assert(raw(h).includes('ZEN_READ_SECRET_ONE'));
  });
  tmux('send-keys', '-t', h.name, 'C-o');
  await wait(h, (_s, list) => list.filter((e) => e.type === 'frame' && e.id === h.lastId).at(-1)?.expanded === false, 'Ctrl+O collapse');
  const offOffset = events(h).length;
  await command(h, '/zen off');
  await wait(h, (_s, list) => list.slice(offOffset).some((e) => e.type === 'frame' && e.tool === 'zen_native' && e.lines.join('\n').includes('NATIVE_RESULT')), '/zen off existing blocks');
  check(`${h.mode}: off delegates existing native and generic blocks`, () => {
    const frames = events(h).slice(offOffset).filter((e) => e.type === 'frame');
    assert(frames.some((f) => f.tool === 'zen_native' && f.lines.join('\n').includes('native second call line')));
    assert(frames.some((f) => f.tool === 'zen_generic' && f.lines.join('\n').includes('ZEN_FINAL_SECRET_OK')));
    assert.equal(JSON.parse(readFileSync(h.config, 'utf8')).filter, false);
  });
  const onOffset = events(h).length;
  await command(h, '/zen on');
  await wait(h, (_s, list) => list.slice(onOffset).some((e) => e.type === 'frame' && e.id === h.lastId), '/zen on existing blocks');
  check(`${h.mode}: on restores existing compact blocks`, () => compact(events(h).slice(onOffset).filter((e) => e.type === 'frame')), true);
  check(`${h.mode}: toggle writes only test config`, () => assert.equal(JSON.parse(readFileSync(h.config, 'utf8')).filter, true));
}
async function mouse(h) {
  // Latest read block is short enough to stay in the fullscreen viewport.
  const screen = capture(h), rows = screen.split('\n');
  const y = rows.findIndex((line) => line.includes('read-case.txt')) + 1;
  assert(y > 0, `Read row not visible for mouse test\n${screen}`);
  const click = `\x1b[<0;5;${y}M\x1b[<0;5;${y}m`;
  tmux('send-keys', '-t', h.name, '-l', click);
  await wait(h, (s, list) => s.includes('ZEN_READ_SECRET_ONE') && list.filter((e) => e.type === 'frame' && e.id === h.lastId).at(-1)?.expanded, 'fullscreen native mouse expansion');
  check('fullscreen: mouse expands completed compact row', () => assert(capture(h).includes('ZEN_READ_SECRET_ONE')));
  tmux('send-keys', '-t', h.name, 'C-o');
  // Ctrl+O toggles the global default, which was false before the per-block mouse click.
  tmux('send-keys', '-t', h.name, 'C-o');
  await wait(h, (_s, list) => list.filter((e) => e.type === 'frame' && e.id === h.lastId).at(-1)?.expanded === false, 'collapse after mouse');
}
async function reload(h) {
  const before = events(h).length, readyCount = events(h).filter((e) => e.type === 'ready').length;
  const initialSession = events(h).find((e) => e.type === 'ready').session;
  await send(h, '/reload');
  await wait(h, (_s, list) => list.filter((e) => e.type === 'ready').length > readyCount &&
    list.slice(before).some((e) => e.type === 'frame' && e.id === h.lastId), 'reload with existing tool blocks');
  check(`${h.mode}: reload keeps isolated session and compact setting`, () => {
    assert.equal(events(h).filter((e) => e.type === 'ready').at(-1).session, initialSession);
    assert.equal(JSON.parse(readFileSync(h.config, 'utf8')).filter, true);
    assert(events(h).slice(before).some((e) => e.type === 'shutdown'));
  });
  check(`${h.mode}: reload rebuilds completed compact blocks`, () => compact(events(h).slice(before).filter((e) => e.type === 'frame')), true);
  await turn(h, 'SUCCESS');
}
async function idle(h) {
  await sleep(1200); // Native tool timers, spinners and footer settlement must all stop.
  for (let i = 1; i <= 3; i++) {
    const bytes = Buffer.byteLength(raw(h)), writes = events(h).filter((e) => e.type === 'write').length;
    await sleep(350); inspect(h);
    const byteDelta = Buffer.byteLength(raw(h)) - bytes, writeDelta = events(h).filter((e) => e.type === 'write').length - writes;
    metrics.push({ mode: h.mode, phase: 'idle', interval: i, bytes: byteDelta, writes: writeDelta });
    check(`${h.mode}: idle interval ${i} has zero bytes and terminal writes`, () => { assert.equal(byteDelta, 0); assert.equal(writeDelta, 0); });
  }
}
try {
  for (const mode of ['fullscreen', 'regular']) {
    const h = await start(mode);
    try {
      await turn(h, 'SUCCESS'); await turn(h, 'GENERIC'); await turn(h, 'BASH');
      if (mode === 'fullscreen') {
        await turn(h, 'INTERACT', { interact: true });
        await turn(h, 'BASH_INTERACT', { interact: true });
      }
      await resize(h, 36); await turn(h, 'FAIL');
      await resize(h, 80); await turn(h, 'BASH_ABORT', { abort: true });
      await turn(h, 'ABORT', { abort: true }); await turn(h, 'READ');
      if (mode === 'fullscreen') await mouse(h);
      await toggles(h); await resize(h, 120); await reload(h); await idle(h);
    } finally { await stop(h); }
  }
} catch (error) {
  for (const h of owned.values()) {
    console.error(`DIAGNOSTIC ${h.mode}: ${JSON.stringify(events(h).filter((e) => e.type === 'frame').slice(-4).map(({ ansi, ...e }) => e))}`);
    console.error(`PANE ${h.mode}:\n${run('tmux', ['capture-pane', '-p', '-t', h.name], true)}`);
  }
  throw error;
} finally {
  for (const h of owned.values()) await stop(h);
  check('owned Pi descendants and tmux sessions removed', () => {
    for (const h of owned.values()) {
      assert(!h.pid || !alive(h.pid)); assert(!(h.children ?? []).some(alive));
      assert.notEqual(run('tmux', ['list-sessions', '-F', '#{session_name}'], true).split('\n').includes(h.name), true);
    }
  });
  // Audit only. Never reap unrelated processes belonging to another worker.
  const audit = run('reap-strays', ['--dry-run', '--report'], true);
  console.log(`RESOURCE AUDIT ${audit.split('\n').filter((line) => line.includes(`ag-zen-${process.pid}-`)).join('\n') || 'no owned tmux strays'}`);
  rmSync(root, { recursive: true, force: true });
  check('temporary agent, config, session and ANSI data removed', () => assert(!existsSync(root)));
  console.log(`METRICS ${JSON.stringify(metrics)}`);
  if (measureOnly) console.log(`OBSERVATIONS ${JSON.stringify(observations)}`);
}
console.log(`Checks: ${checks.length} passed${measureOnly ? ' (measurement mode)' : ''}; runtime ${(performance.now() - testStarted).toFixed(0)}ms`);
