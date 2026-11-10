#!/usr/bin/env node
/** Isolated tmux rendering, streaming, clipboard, startup, and idle checks. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { repo, cli, version, fixtures, tui } from './fixtures/code-blocks-runtime.mjs';
const root = mkdtempSync('/tmp/pi-codeblocks-live-');
const deadline = Date.now() + 8 * 60_000;
const sleep = ms => new Promise(done => setTimeout(done, ms));
const quote = text => "'" + String(text).replaceAll("'", "'\\''") + "'";
const owned = new Map();
const baselinePath = process.env.CODEBLOCK_LIVE_BASELINE;
const baselineVariant = baselinePath ? 'baseline' : 'native';
const trials = Number(process.env.CODEBLOCK_LIVE_TRIALS ?? 5);
const report = { root, pi: version, baselinePath, trials, checks: [], hosts: [], bench: [] };
function run(bin, args, optional = false) {
  try { return execFileSync(bin, args, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { if (optional) return ''; throw new Error(`${bin}: ${error.stderr ?? error.message}`); }
}
const tmux = (...args) => run('tmux', args);
const events = host => existsSync(host.events) ? readFileSync(host.events, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const capture = host => tmux('capture-pane', '-p', '-t', host.name);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
function pass(text) { report.checks.push(text); console.log('PASS ' + text); }
async function wait(host, condition, description, ms = 35000) {
  const until = Math.min(Date.now() + ms, deadline);
  let screen = '';
  while (Date.now() < until) {
    screen = capture(host);
    assert(!/Extension error|Failed to load extension|uncaughtException|TypeError:|Error in render|exceeds terminal width/.test(screen), screen);
    assert.equal(tmux('display-message', '-p', '-t', host.name, '#{pane_dead}').trim(), '0', screen);
    if (condition(screen, events(host))) return screen;
    await sleep(100);
  }
  throw new Error(`Timed out ${description}:\n${screen}`);
}
async function command(host, text) {
  tmux('send-keys', '-t', host.name, 'C-u');
  tmux('send-keys', '-t', host.name, '-l', text);
  tmux('send-keys', '-t', host.name, 'Enter');
  await sleep(120);
}
function seed(area, cwd) {
  const timestamp = new Date().toISOString();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const text = '## Seeded visual baseline\n\n' + fixtures.small + '\n\n' + fixtures.filename + '\n\n' + fixtures.long + '\n\n' + fixtures.mermaid + '\n\nCODEBLOCK_SEED_READY';
  const records = [
    { type: 'session', version: 3, id: randomUUID(), timestamp, cwd },
    { type: 'model_change', id: 'model001', parentId: null, timestamp, provider: 'codeblocks-fixture', modelId: 'fixture' },
    { type: 'message', id: 'user0001', parentId: 'model001', timestamp, message: { role: 'user', content: [{ type: 'text', text: 'Isolated visual fixture' }], timestamp: Date.now() } },
    { type: 'message', id: 'reply001', parentId: 'user0001', timestamp, message: { role: 'assistant', api: 'codeblocks-fixture-stream', provider: 'codeblocks-fixture', model: 'fixture', content: [{ type: 'text', text }], usage, stopReason: 'stop', timestamp: Date.now() } },
  ];
  const path = join(area, 'seed.jsonl'); writeFileSync(path, records.map(x => JSON.stringify(x)).join('\n') + '\n'); return path;
}
async function start(variant, mode, trial) {
  const area = join(root, `${variant}-${mode}-${trial}`), config = join(area, 'agent'), cwd = join(area, 'cwd');
  mkdirSync(config, { recursive: true }); mkdirSync(cwd);
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ theme: 'dark', outputPad: 0, markdown: { codeBlockIndent: '' }, quietStartup: true, tuiMode: mode, fullscreenCopyOnSelect: false, enableAnalytics: false, enableInstallTelemetry: false, cacheWarming: 'off', compaction: { enabled: false } }));
  const host = { name: `ag-codeblocks-${process.pid}-${variant}-${mode}-${trial}`, area, events: join(area, 'events.jsonl'), log: join(area, 'ansi.log'), variant, mode };
  const preload = join(repo, 'scripts/fixtures/status-bar-clipboard.cjs');
  const env = { HOME: area, PATH: process.env.PATH, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8', PI_CODING_AGENT_DIR: config, PI_SKIP_VERSION_CHECK: '1', PI_OFFLINE: '1', PI_TRUE_COLOR: '1', PI_IMAGE_PROTOCOL: 'none', PI_PROGRAM_STATUS: '0', PI_TUI_WRITE_LOG: host.log, SB_LIVE_EVENTS: host.events, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` };
  const args = [process.execPath, cli, '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve', '--no-mcp', '--no-themes', '--no-tools', '--provider', 'codeblocks-fixture', '--model', 'fixture', '--thinking', 'off', '--session-dir', join(area, 'sessions'), '--session', seed(area, cwd), ...(variant !== 'native' ? ['-e', variant === 'baseline' ? baselinePath : join(repo, 'pi/.pi/agent/extensions/code-blocks/index.ts')] : []), ...(variant === 'integration' ? ['zen.ts', 'status-bar.ts', 'filechanges.ts'].flatMap(name => ['-e', join(repo, 'pi/.pi/agent/extensions', name)]) : []), '-e', join(repo, 'scripts/fixtures/code-blocks-live.ts')];
  const launch = `cd ${quote(cwd)} && exec env -i ${Object.entries(env).map(([k, v]) => quote(k + '=' + v)).join(' ')} ${args.map(quote).join(' ')}`;
  tmux('new-session', '-d', '-s', host.name, '-x', '96', '-y', '58', '/bin/sleep 480'); owned.set(host.name, host);
  run('reap-strays', ['--register-tmux', host.name, '--owner', String(process.pid), '--deadline', String(Math.ceil(deadline / 1000))]);
  tmux('set-option', '-t', host.name, 'remain-on-exit', 'on');
  const start = performance.now(); tmux('respawn-pane', '-k', '-t', host.name, launch);
  host.pid = Number(tmux('display-message', '-p', '-t', host.name, '#{pane_pid}').trim());
  const screen = await wait(host, (text, list) => list.some(x => x.type === 'ready') && text.includes('CODEBLOCK_SEED_READY') && (variant === 'native' || text.includes('╭─ typescript')), 'first paint');
  host.startupMs = performance.now() - start;
  writeFileSync(join(area, 'seed-96.txt'), screen);
  writeFileSync(join(area, 'seed-96.ansi'), tmux('capture-pane', '-p', '-e', '-t', host.name));
  report.hosts.push({ name: host.name, pid: host.pid, variant, mode, trial, startupMs: host.startupMs });
  return host;
}
async function stop(host) {
  run('tmux', ['send-keys', '-t', host.name, 'C-u', 'C-d'], true);
  await sleep(400);
  run('tmux', ['kill-session', '-t', host.name], true);
  const until = Date.now() + 3000;
  while (alive(host.pid) && Date.now() < until) await sleep(100);
  assert(!alive(host.pid), `Test Pi ${host.pid} remains alive`); owned.delete(host.name);
}
function assertNeutralCode(host, theme) {
  const raw = tmux('capture-pane', '-p', '-e', '-t', host.name);
  const code = raw.split('\n').filter(line => /(?:const answer|function greet|return .*Hello|printf)/.test(tui.stripTerminalSequences(line)));
  assert(code.length >= 4, 'Code cells missing');
  assert(code.every(line => !/\x1b\[48[;m]/.test(line)), theme + ': tinted code background');
}
function stats(host) {
  const rows = run('ps', ['-p', String(host.pid), '-o', 'rss=', '-o', 'time=']).trim().split(/\s+/);
  const parts = rows[1].split(':').map(Number);
  return { rssKB: Number(rows[0]), cpuMs: parts.reduce((n, x) => n * 60 + x, 0) * 1000, ansiBytes: existsSync(host.log) ? readFileSync(host.log).length : 0 };
}
try {
  for (let trial = 0; trial < trials; trial++) for (const variant of trial % 2 ? ['candidate', baselineVariant] : [baselineVariant, 'candidate']) {
    const host = await start(variant, 'fullscreen', trial);
    if (trial === 0) {
      if (variant === 'candidate') {
        // Copy and reload checks are separate from the startup measurements.
        await command(host, '/copyblock 3');
        await wait(host, (_screen, list) => list.some(x => x.type === 'clipboard'), 'safe code copying');
        assert.equal(events(host).find(x => x.type === 'clipboard').text, 'printf "%s\\n" "' + 'Long source line '.repeat(8).trim() + '"');
        pass('Real /copyblock preserves one logical command without touching system clipboard');
        await command(host, '/reload');
        await wait(host, (screen, list) => list.filter(x => x.type === 'ready').length >= 2 && screen.includes('╭─ typescript'), 'reload');
        pass('Real /reload keeps one code-frame instance');
      }
      await command(host, 'Stream the fixture reply');
      const screen = await wait(host, (text, list) => text.includes('CODEBLOCK_REVIEW_READY') && list.some(x => x.type === 'settled'), 'streaming settlement');
      assert(screen.includes('│ Pi reply │'));
      assert.equal(screen.includes('╭─ typescript'), variant !== 'native');
      const records = readFileSync(events(host).filter(x => x.type === 'ready').at(-1).session, 'utf8');
      assert(records.includes('```typescript example.ts'), 'Session source changed');
      if (variant === 'candidate') assert(events(host).find(x => x.type === 'guidance').rules.some(x => x.includes('top-level Mermaid')));
      writeFileSync(join(host.area, 'reply-96.ansi'), tmux('capture-pane', '-p', '-e', '-t', host.name));
      pass(`${variant}: real streaming reply and native Mermaid render, original source persists`);
      for (const width of [60, 36, 96]) {
        tmux('resize-window', '-t', host.name, '-x', String(width), '-y', '68');
        await sleep(350);
        const resized = await wait(host, text => text.includes('CODEBLOCK_REVIEW_READY') && (variant !== 'candidate' || text.includes('╭─ typescript')), 'resize');
        assert(!resized.includes('exceeds terminal width'));
        writeFileSync(join(host.area, `reply-${width}.txt`), resized);
        writeFileSync(join(host.area, `reply-${width}.ansi`), tmux('capture-pane', '-p', '-e', '-t', host.name));
      }
      if (variant === 'candidate') {
        await command(host, '/visual-theme light');
        await wait(host, (_screen, list) => list.some(x => x.type === 'theme'), 'light theme');
        await sleep(200);
        assertNeutralCode(host, 'light');
        writeFileSync(join(host.area, 'reply-light.ansi'), tmux('capture-pane', '-p', '-e', '-t', host.name));
        await command(host, '/visual-theme dark');
        await wait(host, (_screen, list) => list.filter(x => x.type === 'theme').length === 2, 'dark theme');
        await sleep(200);
        assertNeutralCode(host, 'dark');
        writeFileSync(join(host.area, 'reply-dark.ansi'), tmux('capture-pane', '-p', '-e', '-t', host.name));
        pass('Real dark and light code frames use terminal background without success tint');
      }
      pass(`${variant}: resize from 36 to 96 columns remains readable`);
    }
    await sleep(700);
    const before = stats(host); await sleep(2000); const after = stats(host);
    if (trial > 0) report.bench.push({ variant, trial, startupMs: host.startupMs, rssKB: after.rssKB, idleCpuMs: after.cpuMs - before.cpuMs, idleAnsiBytes: after.ansiBytes - before.ansiBytes });
    assert(!events(host).some(x => ['fixture-error', 'clipboard-blocked'].includes(x.type)), JSON.stringify(events(host)));
    await stop(host);
  }
  const regular = await start('candidate', 'regular', 0);
  assert(capture(regular).includes('╭─ typescript'));
  pass('Regular terminal mode also shows reply frames'); await stop(regular);
  const integration = await start('integration', 'fullscreen', 0);
  assert(capture(integration).includes('╭─ typescript'));
  await command(integration, 'Stream the integration reply');
  await wait(integration, (text, list) => text.includes('CODEBLOCK_REVIEW_READY') && list.some(x => x.type === 'settled'), 'visual stack integration');
  assert(capture(integration).includes('╭─ bash'));
  pass('Reply frames and native Mermaid work with Zen, status bar, and filechanges'); await stop(integration);
  console.log('LIVE_BENCH ' + JSON.stringify(report.bench));
} finally {
  for (const host of owned.values()) { try { await stop(host); } catch (error) { console.error(String(error)); } }
  const path = process.env.CODEBLOCK_LIVE_REPORT ?? join(root, 'report.json');
  writeFileSync(path, JSON.stringify(report, null, 2)); console.log('Report: ' + path);
}
