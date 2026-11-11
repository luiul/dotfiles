#!/usr/bin/env node
/** Private Rex rendering, streaming, clipboard, startup, and idle checks. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { repo, cli, version, fixtures, tui } from './fixtures/code-blocks-runtime.mjs';
import { RexTestDriver } from './rex-test-driver.mjs';
assert(!process.versions.bun, 'Run this live harness with native Node');
const root = mkdtempSync('/tmp/pi-codeblocks-live-');
const deadline = Date.now() + 8 * 60_000;
const sleep = ms => new Promise(done => setTimeout(done, ms));
const owned = new Map();
let driver;
const baselinePath = process.env.CODEBLOCK_LIVE_BASELINE;
const baselineVariant = baselinePath ? 'baseline' : 'native';
const trials = Number(process.env.CODEBLOCK_LIVE_TRIALS ?? 5);
const report = { root, pi: version, baselinePath, trials, checks: [], hosts: [], bench: [],
  backend: 'private Rex', startupMeasurement: 'terminal creation, login, registration, PID discovery and first captured paint',
  comparability: 'same-run Rex variants only; not comparable with historic tmux startup measurements' };
function run(bin, args, optional = false) {
  try { return execFileSync(bin, args, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { if (optional) return ''; throw new Error(`${bin}: ${error.stderr ?? error.message}`); }
}
const events = host => existsSync(host.events) ? readFileSync(host.events, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const capture = host => driver.capture(host);
const styled = host => driver.capture(host, { format: 'vt', history: true });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
function pass(text) { report.checks.push(text); console.log('PASS ' + text); }
async function wait(host, condition, description, ms = 35000) {
  const until = Math.min(Date.now() + ms, deadline);
  let screen = '';
  while (Date.now() < until) {
    screen = capture(host);
    assert(!/Extension error|Failed to load extension|uncaughtException|TypeError:|Error in render|exceeds terminal width/.test(screen), screen);
    assert(!driver.process(host).last_exit && alive(host.pid), screen);
    if (condition(screen, events(host))) return screen;
    await sleep(100);
  }
  throw new Error(`Timed out ${description}:\n${screen}`);
}
async function command(host, text) {
  driver.key(host, 'ctrl+u');
  driver.text(host, text);
  driver.key(host, 'enter');
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
  // Direct creation retains exit output. The driver owns the private server and
  // records the exec target PID separately from Rex's outer login child.
  const start = performance.now();
  Object.assign(host, driver.create({ name: host.name, command: args, cwd, env, columns: 96, rows: 58 }));
  owned.set(host.name, host);
  const pidDeadline = Math.min(Date.now() + 10_000, deadline);
  while (!(host.pid = driver.pid(host)) && Date.now() < pidDeadline) await sleep(100);
  assert(Number.isSafeInteger(host.pid) && host.pid > 1, `Target PID missing for ${host.name}`);
  const screen = await wait(host, (text, list) => list.some(x => x.type === 'ready') && text.includes('CODEBLOCK_SEED_READY') && (variant === 'native' || text.includes('╭─ typescript')), 'first paint');
  host.startupMs = performance.now() - start;
  assert.equal(events(host).find(x => x.type === 'ready').pid, host.pid, 'Driver PID must name the Pi target');
  writeFileSync(join(area, 'seed-96.txt'), screen);
  writeFileSync(join(area, 'seed-96.ansi'), styled(host));
  report.hosts.push({ name: host.name, pid: host.pid, variant, mode, trial, startupMs: host.startupMs });
  return host;
}
async function stop(host) {
  if (!host.closed) {
    if (alive(host.pid)) {
      driver.key(host, 'ctrl+u');
      driver.key(host, 'ctrl+d');
      await sleep(400);
    }
    driver.close(host);
    host.closed = true;
  }
  const until = Date.now() + 3000;
  while (alive(host.pid) && Date.now() < until) await sleep(100);
  assert(!alive(host.pid), `Test Pi ${host.pid} remains alive`); owned.delete(host.name);
}
function assertNeutralCode(host, theme) {
  // VT capture is a redraw, not the raw write log. Carry SGR background state
  // across rows, then inspect only the current viewport, not old theme history.
  let background = false;
  const rows = styled(host).replaceAll('\r\n', '\n').split('\n').map(line => {
    let tinted = false, offset = 0;
    for (const match of line.matchAll(/\x1b\[([0-9;:]*)m/g)) {
      if (background && tui.stripTerminalSequences(line.slice(offset, match.index)).length) tinted = true;
      const params = match[1].split(';');
      for (let i = 0; i < params.length; i++) {
        const code = Number(params[i].split(':')[0]);
        if (code === 0 || code === 49) background = false;
        else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) background = true;
        else if (code === 38 || code === 48 || code === 58) {
          if (code === 48) background = true;
          // Color components are not SGR commands, including a zero component.
          if (!params[i].includes(':')) i += Number(params[i + 1]) === 2 ? 4 : Number(params[i + 1]) === 5 ? 2 : 0;
        }
      }
      offset = match.index + match[0].length;
    }
    if (background && tui.stripTerminalSequences(line.slice(offset)).length) tinted = true;
    return { text: tui.stripTerminalSequences(line), tinted };
  });
  const code = rows.slice(-host.rows).filter(line => /(?:const answer|function greet|return .*Hello|printf)/.test(line.text));
  assert(code.length >= 4, 'Code cells missing');
  assert(code.every(line => !line.tinted), theme + ': tinted code background');
}
function stats(host) {
  const rows = run('ps', ['-p', String(host.pid), '-o', 'rss=', '-o', 'time=']).trim().split(/\s+/);
  const parts = rows[1].split(':').map(Number);
  return { rssKB: Number(rows[0]), cpuMs: parts.reduce((n, x) => n * 60 + x, 0) * 1000, ansiBytes: existsSync(host.log) ? readFileSync(host.log).length : 0 };
}
try {
  driver = await RexTestDriver.start({ deadlineMs: Math.max(1000, deadline - Date.now()) });
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
      writeFileSync(join(host.area, 'reply-96.ansi'), styled(host));
      pass(`${variant}: real streaming reply and native Mermaid render, original source persists`);
      for (const width of [60, 36, 96]) {
        driver.resize(host, width, 68);
        await sleep(350);
        const resized = await wait(host, text => text.includes('CODEBLOCK_REVIEW_READY') && (variant !== 'candidate' || text.includes('╭─ typescript')), 'resize');
        assert(!resized.includes('exceeds terminal width'));
        writeFileSync(join(host.area, `reply-${width}.txt`), resized);
        writeFileSync(join(host.area, `reply-${width}.ansi`), styled(host));
      }
      if (variant === 'candidate') {
        await command(host, '/visual-theme light');
        await wait(host, (_screen, list) => list.some(x => x.type === 'theme'), 'light theme');
        await sleep(200);
        assertNeutralCode(host, 'light');
        writeFileSync(join(host.area, 'reply-light.ansi'), styled(host));
        await command(host, '/visual-theme dark');
        await wait(host, (_screen, list) => list.filter(x => x.type === 'theme').length === 2, 'dark theme');
        await sleep(200);
        assertNeutralCode(host, 'dark');
        writeFileSync(join(host.area, 'reply-dark.ansi'), styled(host));
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
  try { await driver?.stop(); }
  finally {
    const path = process.env.CODEBLOCK_LIVE_REPORT ?? join(root, 'report.json');
    writeFileSync(path, JSON.stringify(report, null, 2)); console.log('Report: ' + path);
  }
}
