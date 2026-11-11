#!/usr/bin/env node
/** Real Pi TUI cancellation and native shutdown comparison, without model network calls. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = readFileSync(join(homedir(), '.pi/agent/install/current-version'), 'utf8').trim();
const cli = join(homedir(), '.pi/agent/install/releases', version, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
const packages = join(homedir(), '.pi/agent/npm/node_modules');
const root = mkdtempSync(join(tmpdir(), 'pi-exit-live-'));
const deadline = Date.now() + 12 * 60_000;
const scenarios = (process.env.EXIT_LIVE_SCENARIOS ?? 'streaming,tool,queued,retry,compaction,context,subagent').split(',').filter(Boolean);
const trials = Number(process.env.EXIT_LIVE_TRIALS ?? 3);
const reaper = join(homedir(), 'dotfiles/macos/.local/bin/reap-strays');
const owned = new Map();
const results = [];
const quote = text => "'" + String(text).replaceAll("'", "'\\''") + "'";
function run(bin, args, optional = false) {
  try { return execFileSync(bin, args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { if (optional) return ''; throw new Error(`${bin}: ${error.stderr ?? error.message}`); }
}
const tmux = (...args) => run('tmux', args);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const events = host => existsSync(host.events) ? readFileSync(host.events, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const capture = host => tmux('capture-pane', '-p', '-t', host.name);
async function wait(host, predicate, label, ms = 30000) {
  const until = Math.min(Date.now() + ms, deadline);
  while (Date.now() < until) {
    const screen = capture(host);
    assert(!/Failed to load extension|Extension error|TypeError:|uncaughtException/.test(screen), screen);
    if (predicate(screen, events(host))) return screen;
    if (tmux('display-message', '-p', '-t', host.name, '#{pane_dead}').trim() === '1') {
      if (predicate(capture(host), events(host))) return capture(host);
      throw new Error(`Exited before ${label}: ${capture(host)}`);
    }
    await delay(50);
  }
  throw new Error(`Timeout ${label}: ${capture(host)}\n${JSON.stringify(events(host))}`);
}
function command(host, text) {
  tmux('send-keys', '-t', host.name, 'C-u', text, 'Enter');
}
function descendants(pid) {
  const rows = run('ps', ['-axo', 'pid=,ppid=,lstart=']).trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match && { pid: Number(match[1]), ppid: Number(match[2]), start: match[3] };
  }).filter(Boolean);
  const ids = new Set([pid]);
  for (let i = 0; i < rows.length; i++) for (const row of rows) if (ids.has(row.ppid)) ids.add(row.pid);
  return rows.filter(row => ids.has(row.pid));
}
async function start(scenario, variant, trial = 0, autoDiscover = false) {
  const area = join(root, `${scenario}-${variant}-${trial}`);
  const config = join(area, 'agent'), cwd = join(area, 'cwd');
  mkdirSync(config, { recursive: true }); mkdirSync(cwd);
  const host = { name: `ag-pi-exit-${process.pid}-${scenario}-${variant}-${trial}`, area, events: join(area, 'events.jsonl'), worker: join(area, 'worker.pid'), scenario, variant, tracked: [] };
  const fixture = join(repo, 'scripts/fixtures/exit-live.ts');
  const extension = process.env.EXIT_LIVE_EXTENSION ?? join(repo, 'pi/.pi/agent/extensions/exit.ts');
  const extras = [];
  if (scenario === 'context') {
    mkdirSync(join(config, 'npm/node_modules'), { recursive: true });
    symlinkSync(join(packages, 'context-mode'), join(config, 'npm/node_modules/context-mode'), 'dir');
    extras.push('-e', join(packages, 'context-mode/build/adapters/pi/extension.js'));
  }
  if (scenario === 'subagent') {
    extras.push('-e', join(packages, '@tintinweb/pi-subagents/src/index.ts'));
    mkdirSync(join(config, 'agents'));
    writeFileSync(join(config, 'agents/exit-child.md'), '---\nname: exit-child\ndescription: Private cleanup fixture\nmodel: exit-fixture/fixture\nthinking: off\ntools: read\nextensions: [exit-live]\n---\nWait for cancellation.\n');
    writeFileSync(join(config, 'subagents.json'), JSON.stringify({ scopeModels: false, workflowsEnabled: false, schedulingEnabled: false, widgetMode: 'off', fleetView: false }));
  }
  if (autoDiscover) {
    mkdirSync(join(config, 'extensions')); symlinkSync(extension, join(config, 'extensions/exit.ts'));
  }
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ quietStartup: true, enableAnalytics: false, enableInstallTelemetry: false, cacheWarming: 'off', compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: true, maxRetries: 3, baseDelayMs: 30000 }, packages: [], extensions: [fixture] }));
  const env = { HOME: area, PATH: process.env.PATH, TERM: 'xterm-256color', LANG: 'en_US.UTF-8', PI_CODING_AGENT_DIR: config, PI_SKIP_VERSION_CHECK: '1', PI_OFFLINE: '1', PI_IMAGE_PROTOCOL: 'none', PI_PROGRAM_STATUS: '0', EXIT_LIVE_EVENTS: host.events, EXIT_LIVE_SCENARIO: scenario, EXIT_LIVE_WORKER_PID: host.worker, CONTEXT_MODE_BRIDGE_DEPTH: '0', CONTEXT_MODE_PROJECT_DIR: cwd };
  const args = [process.execPath, cli, '--offline', ...(!autoDiscover ? ['--no-extensions', '-e', fixture] : []), '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve', '--no-mcp', '--no-themes', '--provider', 'exit-fixture', '--model', 'fixture', '--thinking', 'off', '--session-dir', join(area, 'sessions'), ...(variant === 'exit' && !autoDiscover ? ['-e', extension] : []), ...extras];
  const launch = `cd ${quote(cwd)}; stty -g > ${quote(join(area, 'stty-before'))}; env -i ${Object.entries(env).map(([k, v]) => quote(k + '=' + v)).join(' ')} ${args.map(quote).join(' ')}; rc=$?; stty -g > ${quote(join(area, 'stty-after'))}; printf '%s' "$rc" > ${quote(join(area, 'exit-code'))}; exit "$rc"`;
  tmux('new-session', '-d', '-s', host.name, '-x', '100', '-y', '36', '/bin/sleep 720'); owned.set(host.name, host);
  run(reaper, ['--register-tmux', host.name, '--owner', String(process.pid), '--deadline', String(Math.ceil(deadline / 1000))]);
  tmux('set-option', '-t', host.name, 'remain-on-exit', 'on');
  tmux('respawn-pane', '-k', '-t', host.name, '/bin/sh -c ' + quote(launch));
  host.launchPid = Number(tmux('display-message', '-p', '-t', host.name, '#{pane_pid}').trim());
  host.tracked = descendants(host.launchPid);
  await wait(host, (_screen, list) => list.some(x => x.type === 'ready'), 'startup');
  host.pid = events(host).find(x => x.type === 'ready').pid;
  if (scenario !== 'idle') {
    if (scenario === 'subagent') {
      command(host, '/exit-child-start');
      await wait(host, (_screen, list) => list.some(x => x.type === 'child-spawn' && x.success) && list.some(x => x.type === 'request' && x.child), 'active SDK child');
    }
    command(host, 'Run the isolated exit fixture.');
    if (scenario === 'compaction') {
      await wait(host, (_screen, list) => list.some(x => x.type === 'settled'), 'seed reply');
      command(host, 'Add a second turn for manual compaction.');
      await wait(host, (_screen, list) => list.filter(x => x.type === 'settled').length === 2, 'second seed reply');
      command(host, '/compact');
      await wait(host, (_screen, list) => list.some(x => x.type === 'compaction'), 'manual compaction');
    } else if (scenario === 'tool' || scenario === 'context') {
      await wait(host, () => existsSync(host.worker), 'active child tool', 40000);
      host.workerPid = Number(readFileSync(host.worker, 'utf8').trim());
      assert(alive(host.workerPid), 'Worker never became active');
    } else if (scenario === 'retry') {
      await wait(host, screen => /Retrying|retry.*1\/3/i.test(screen), 'retry delay');
    } else await wait(host, (screen, list) => screen.includes('EXIT_STREAM_READY') && list.some(x => x.type === 'request'), 'active stream');
    if (scenario === 'queued' || scenario === 'compaction') {
      command(host, 'QUEUED_PROMPT_MUST_NOT_RUN');
      await wait(host, screen => /Steering:|Queued message/.test(screen), 'queued prompt');
    }
  }
  refreshOwnership(host);
  return host;
}
function refreshOwnership(host) {
  const current = descendants(host.launchPid ?? host.pid);
  const identities = new Map(host.tracked.map(row => [row.pid + ':' + row.start, row]));
  for (const row of current) identities.set(row.pid + ':' + row.start, row);
  host.tracked = [...identities.values()];
}
let cleanupPromise;
function cleanup() {
  return cleanupPromise ??= (async () => {
    for (const host of owned.values()) refreshOwnership(host);
    for (const host of owned.values()) {
      run('tmux', ['send-keys', '-t', host.name, 'C-c', 'C-c'], true);
      await delay(1500);
      run('tmux', ['kill-session', '-t', host.name], true);
      for (const row of host.tracked) if (alive(row.pid)) {
        const identity = run('ps', ['-p', String(row.pid), '-o', 'lstart='], true).trim();
        if (identity === row.start) { try { process.kill(row.pid, 'SIGKILL'); } catch {} }
      }
      await delay(100);
      for (const row of host.tracked) {
        const identity = run('ps', ['-p', String(row.pid), '-o', 'lstart='], true).trim();
        assert(identity !== row.start, `Cleanup survivor: ${JSON.stringify(row)}`);
      }
    }
    owned.clear();
    rmSync(root, { recursive: true, force: true });
  })();
}
const terminate = code => { cleanup().then(() => process.exit(code), error => { console.error(error); process.exit(1); }); };
process.once('SIGINT', () => terminate(130));
process.once('SIGTERM', () => terminate(143));
const suiteBound = setTimeout(() => terminate(124), deadline - Date.now());
async function finish(host) {
  refreshOwnership(host);
  const before = events(host).filter(x => x.type === 'request').length;
  const began = performance.now();
  if (host.variant === 'exit') command(host, '/exit');
  else if (host.variant === 'quit') command(host, '/quit');
  else tmux('send-keys', '-t', host.name, 'C-c', 'C-c');
  await wait(host, () => existsSync(join(host.area, 'exit-code')), 'clean exit', 15000);
  const elapsedMs = performance.now() - began;
  assert.equal(readFileSync(join(host.area, 'exit-code'), 'utf8'), '0');
  const list = events(host);
  assert.equal(list.filter(x => x.type === 'shutdown' && x.mode === 'tui').length, 1, 'Shutdown hook count');
  assert(list.some(x => x.type === 'cleanup-complete' && x.mode === 'tui'), 'Async cleanup not awaited');
  if (host.scenario === 'subagent') {
    assert(list.some(x => x.type === 'subagents-disposed'), 'SDK child disposal missing');
    assert(list.some(x => x.type === 'shutdown' && x.mode !== 'tui'), 'Child shutdown missing');
    assert(list.some(x => x.type === 'cleanup-complete' && x.mode !== 'tui'), 'Child async cleanup missing');
    assert(list.some(x => x.type === 'cancelled' && x.child), 'Child request not cancelled');
  }
  assert.equal(list.find(x => x.type === 'shutdown').reason, 'quit');
  assert.equal(list.filter(x => x.type === 'request').length, before, 'Queued work or retry ran during exit');
  assert.equal(readFileSync(join(host.area, 'stty-after'), 'utf8'), readFileSync(join(host.area, 'stty-before'), 'utf8'), 'Terminal mode not restored');
  const screen = tmux('capture-pane', '-p', '-S', '-2000', '-t', host.name);
  const session = list.find(x => x.type === 'ready').session;
  if (host.scenario !== 'idle') {
    assert(screen.includes('To resume this session:'), screen);
    assert(session && existsSync(session), 'No resumable transcript');
    assert(!readFileSync(session, 'utf8').includes('"text":"/exit"'), '/exit sent to model');
  }
  const until = Date.now() + 6000;
  while (host.tracked.some(row => row.pid !== host.launchPid && alive(row.pid)) && Date.now() < until) await delay(100);
  for (const row of host.tracked) if (row.pid !== host.launchPid) assert(!alive(row.pid), `Owned process survived: ${JSON.stringify(row)}`);
  if (host.workerPid) assert(!alive(host.workerPid), 'Tool worker survived');
  const result = { scenario: host.scenario, variant: host.variant, elapsedMs: Math.round(elapsedMs), processCount: host.tracked.length };
  results.push(result); console.log('PASS ' + JSON.stringify(result));
  assert.equal(tmux('display-message', '-p', '-t', host.name, '#{pane_dead}').trim(), '1', 'Terminal wrapper did not exit');
  tmux('kill-session', '-t', host.name); owned.delete(host.name);
}
try {
  if (process.env.EXIT_LIVE_INTERRUPT) {
    const host = await start('context', 'exit');
    console.log('INTERRUPT_READY ' + JSON.stringify({ root, name: host.name, tracked: host.tracked }));
    await delay(60000);
    throw new Error('Interruption fixture did not receive a signal');
  }
  // Rotated native and candidate trials, with matching async shutdown work.
  for (let trial = 0; trial < trials; trial++) for (const variant of trial % 2 ? ['exit', 'ctrlc'] : ['ctrlc', 'exit']) await finish(await start('idle', variant, trial));
  for (const scenario of scenarios) {
    await finish(await start(scenario, 'ctrlc'));
    await finish(await start(scenario, 'exit'));
  }
  await finish(await start('idle', 'quit'));
  await finish(await start('idle', 'exit', 3, true));
  console.log('PASS global auto-discovery, native /quit unchanged, resumable history, terminal restoration and owned process cleanup');
  const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const measured = results.filter(r => r.scenario === 'idle' && r.variant !== 'quit').slice(0, trials * 2);
  console.log('IDLE_EXIT_MEDIANS_MS ' + JSON.stringify(Object.fromEntries(['ctrlc', 'exit'].filter(variant => measured.some(r => r.variant === variant)).map(variant => [variant, median(measured.filter(r => r.variant === variant).map(r => r.elapsedMs))]))));
  if (process.env.EXIT_LIVE_REPORT) writeFileSync(process.env.EXIT_LIVE_REPORT, JSON.stringify({ pi: version, results }, null, 2));
} finally {
  clearTimeout(suiteBound);
  await cleanup();
}
