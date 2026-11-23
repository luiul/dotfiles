#!/usr/bin/env node
/** Real Pi TUI close-status checks in private Rex, without model network calls. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RexTestDriver } from './rex-test-driver.mjs';

assert(!process.versions.bun, 'Use Node for private Rex tests');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const install = join(homedir(), '.pi/agent/install');
const cli = join(install, 'releases', readFileSync(join(install, 'current-version'), 'utf8').trim(), 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
const extension = join(repo, 'pi/.pi/agent/extensions/close-status.ts');
const footer = join(repo, 'pi/.pi/agent/extensions/status-bar.ts');
const fixture = join(repo, 'scripts/fixtures/close-status-live.ts');
const root = mkdtempSync(join(tmpdir(), 'close-live-'));
const report = { backend: 'RexTestDriver', cli, sources: Object.fromEntries([extension, footer, fixture].map(p => [p, createHash('sha256').update(readFileSync(p)).digest('hex')])), checks: [], cleanup: false };
const deadline = Date.now() + 240000;
let driver;
const hosts = [];
const sleep = ms => new Promise(done => setTimeout(done, ms));
function events(host) { if (!existsSync(host.events)) return []; const text = readFileSync(host.events, 'utf8'); return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(JSON.parse); }
const capture = host => driver.capture(host).replaceAll('\r\n', '\n');
function check(name) { report.checks.push(name); console.log('PASS ' + name); }
async function wait(host, predicate, name, ms = 25000) {
  let screen = '';
  const until = Math.min(deadline, Date.now() + ms);
  while (Date.now() < until) {
    screen = capture(host);
    assert(!/Failed to load extension|Extension error|TypeError:|Unhandled|exceeds terminal width/i.test(screen), screen);
    assert(!driver.process(host).last_exit, 'Host exited: ' + screen);
    if (predicate(screen, events(host))) return screen;
    await sleep(100);
  }
  throw new Error('Timeout ' + name + '\n' + screen + '\n' + JSON.stringify(events(host).slice(-8)));
}
async function command(host, text) { driver.key(host, 'ctrl+u'); driver.text(host, text); driver.key(host, 'enter'); await sleep(100); }
async function prompt(host, text, label) {
  const n = events(host).filter(e => e.type === 'settled').length;
  await command(host, text);
  await wait(host, (screen, list) => list.filter(e => e.type === 'settled').length > n && (!label || screen.includes(label)), text + ' settlement');
  const state = events(host).filter(e => e.type === 'settled').at(-1);
  assert(state.report, 'Settlement metadata must exist');
  return state;
}
async function start(mode) {
  const area = join(root, mode); const config = join(area, 'home/.pi/agent'); mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ quietStartup: true, theme: 'dark', defaultProvider: 'close-live', defaultModel: 'fixture', compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off', enableAnalytics: false, enableInstallTelemetry: false }));
  const host = { events: join(area, 'events.jsonl'), mode, width: 120 };
  Object.assign(host, driver.create({ name: `ag-close-${process.pid}-${mode}`, command: [process.execPath, cli, '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve', '--no-mcp', '--no-themes', '--tools', 'close_live_tool', '--thinking', 'off', '--provider', 'close-live', '--model', 'fixture', '--tui-mode', mode, '--session-dir', join(area, 'sessions'), '-e', extension, '-e', footer, '-e', fixture], cwd: repo,
    env: { HOME: join(area, 'home'), PATH: process.env.PATH, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8', PI_CODING_AGENT_DIR: config, PI_SKIP_VERSION_CHECK: '1', PI_OFFLINE: '1', PI_IMAGE_PROTOCOL: 'none', CLOSE_LIVE_EVENTS: host.events }, columns: host.width, rows: 34 }));
  hosts.push(host);
  await wait(host, (screen, list) => screen.includes('NOT CHECKED') && list.some(e => e.type === 'ready'), 'first paint');
  assert(events(host).find(e => e.type === 'ready').commands.includes('close-status'));
  check(mode + ': startup unknown and command registration');
  return host;
}
try {
  driver = await RexTestDriver.start({ deadlineMs: 240000 });
  for (const mode of ['regular', 'fullscreen']) {
    const host = await start(mode);
    const first = await prompt(host, 'yes', 'SAFE TO CLOSE');
    assert.equal(first.report.report.safe_to_close, 'yes');
    const rendered = capture(host);
    assert(rendered.includes('Reported: Safe to close') && !/safe_to_close:|close_reason:|next_action:/.test(rendered), rendered);
    const styled = driver.capture(host, { format: 'vt' });
    assert(/\x1b\[[\d;]+m/.test(styled), 'Native transcript must retain ANSI styling');
    const rawRecords = readFileSync(first.file, 'utf8').trim().split('\n').map(JSON.parse);
    const originalReply = rawRecords.filter(e => e.type === 'message' && e.message.role === 'assistant').at(-1);
    assert(originalReply.message.content.some(part => part.type === 'text' && part.text.includes('safe_to_close: yes')), 'Display formatting cannot rewrite the stored reply');
    check(mode + ': native verdict display hides fields and preserves original reply');
    assert(events(host).find(e => e.type === 'model-call').guided, 'Static instruction must reach provider');
    check(mode + ': final yes and static instruction');
    await prompt(host, 'legacy-heading', 'SAFE TO CLOSE');
    assert(capture(host).includes('Reported: Safe to close') && !capture(host).includes('safe_to_close:'), 'Screenshot heading must agree with footer');
    check(mode + ': screenshot legacy heading produces matching native verdict and footer');
    await command(host, '/close-live-legacy-report');
    await wait(host, (screen, list) => list.some(e => e.type === 'legacy-report'), 'legacy metadata');
    const beforeLegacyReload = events(host).filter(e => e.type === 'ready').length;
    await command(host, '/reload');
    await wait(host, (screen, list) => list.filter(e => e.type === 'ready').length > beforeLegacyReload && screen.includes('NOT CHECKED'), 'legacy report reload');
    check(mode + ': reload rejects old policy report');
    await prompt(host, 'yes', 'SAFE TO CLOSE');
    const modelCalls = events(host).filter(e => e.type === 'model-call').length;
    await command(host, '/close-status');
    await wait(host, screen => screen.includes('Closing safety report') && screen.includes('Yes (reported)'), 'report overlay');
    // Keyboard scrolling must expose the whole report, even in regular terminal mode.
    for (let i = 0; i < 28; i++) driver.key(host, 'down');
    await wait(host, screen => screen.includes('worktree removal'), 'report limits');
    driver.key(host, 'escape');
    await wait(host, screen => screen.includes('SAFE TO CLOSE') && !screen.includes('Closing safety report'), 'report close');
    assert.equal(events(host).filter(e => e.type === 'model-call').length, modelCalls);
    check(mode + ': command report and scroll without another model call');
    await command(host, '!echo CLOSE_BANG');
    await wait(host, screen => screen.includes('NOT CHECKED') && screen.includes('CLOSE_BANG'), 'bang invalidation');
    assert.equal(events(host).filter(e => e.type === 'model-call').length, modelCalls);
    check(mode + ': idle bang command invalidates report without model call');
    const afterBash = await prompt(host, 'yes');
    // Pi may flush a completed bang entry after the next response. That branch must stay unknown.
    const afterRecords = readFileSync(afterBash.file, 'utf8').trim().split('\n').map(JSON.parse);
    const meta = afterRecords.find(e => e.id === afterBash.leaf);
    const parent = afterRecords.find(e => e.id === meta.parentId);
    assert.equal(afterBash.report.report?.safe_to_close, parent.message.role === 'bashExecution' ? undefined : 'yes');
    check(mode + ': late bang entries fail closed when Pi flushes them after a reply');
    await prompt(host, 'yes', 'SAFE TO CLOSE');
    const slowBefore = events(host).filter(e => e.type === 'settled').length;
    await command(host, 'slow');
    await wait(host, screen => /working\s+\d/i.test(screen) && !screen.includes('SAFE TO CLOSE'), 'new prompt hides yes');
    driver.key(host, 'escape');
    await wait(host, (screen, list) => screen.includes('NOT CHECKED') && list.filter(e => e.type === 'settled').length > slowBefore, 'abort unknown');
    check(mode + ': new work and abort cannot leave green');
    for (const text of ['missing', 'quoted', 'length', 'error']) { await prompt(host, text, 'NOT CHECKED'); check(mode + ': ' + text + ' unknown'); }
    await prompt(host, 'approval', 'KEEP OPEN'); check(mode + ': pending approval no');
    const tool = await prompt(host, 'tool', 'SAFE TO CLOSE');
    assert(events(host).some(e => e.type === 'tool')); assert.equal(tool.report.report.safe_to_close, 'yes'); check(mode + ': final after tool result');
    await prompt(host, 'yes', 'SAFE TO CLOSE');
    const continuation = await prompt(host, 'continue', 'KEEP OPEN');
    assert.equal(continuation.report.report.safe_to_close, 'no'); check(mode + ': automatic continuation uses final report');
    await prompt(host, 'yes', 'SAFE TO CLOSE');
    await command(host, '/compact');
    await wait(host, screen => screen.includes('SAFE TO CLOSE'), 'compaction report');
    check(mode + ': compaction keeps selected branch metadata');
    const readyBefore = events(host).filter(e => e.type === 'ready').length;
    await command(host, '/reload'); await wait(host, (screen, list) => list.filter(e => e.type === 'ready').length > readyBefore && screen.includes('SAFE TO CLOSE'), 'reload restore'); check(mode + ': reload restores branch-local report');
    const original = events(host).filter(e => e.type === 'ready').at(-1);
    await command(host, '/close-live-clone');
    await wait(host, (screen, list) => list.filter(e => e.type === 'ready').at(-1)?.uuid !== original.uuid && screen.includes('SAFE TO CLOSE'), 'clone branch report');
    check(mode + ': clone preserves only selected branch report');
    await command(host, '/close-live-resume ' + original.file);
    await wait(host, (screen, list) => list.filter(e => e.type === 'ready').at(-1)?.uuid === original.uuid && screen.includes('SAFE TO CLOSE'), 'resume report');
    check(mode + ': resume restores original session report');
    const uuid = original.uuid;
    for (const width of [80, 79, 60, 44, 36]) {
      driver.resize(host, width, 34); host.width = width;
      await wait(host, screen => screen.includes(uuid) && /(?:SAFE TO CLOSE|CLOSE: YES)/.test(screen), 'resize ' + width);
      check(mode + ': ' + width + '-column closing status and full UUID');
    }
    driver.resize(host, 120, 34); host.width = 120;
    await wait(host, screen => screen.includes('SAFE TO CLOSE'), 'wide restore');
    const branch = await prompt(host, 'no', 'KEEP OPEN');
    await command(host, '/close-live-tree previous');
    await wait(host, screen => screen.includes('SAFE TO CLOSE'), 'tree previous report'); check(mode + ': selected branch restore');
    await command(host, '/close-live-tree source');
    await wait(host, screen => screen.includes('NOT CHECKED'), 'tree source without settled metadata'); check(mode + ': assistant alone is not persisted settlement');
    const records = readFileSync(branch.file, 'utf8').trim().split('\n').map(JSON.parse);
    const metadata = records.filter(e => e.type === 'custom' && e.customType === 'dotfiles.close-status');
    assert(metadata.length > 0); assert(!records.some(e => e.type === 'custom_message' && e.customType === 'dotfiles.close-status'));
    check(mode + ': closing metadata stays outside model context');
    driver.key(host, 'ctrl+d');
    await sleep(300);
    driver.close(host);
  }
} finally {
  await driver?.stop();
  report.cleanup = true;
  if (process.env.CLOSE_LIVE_REPORT) writeFileSync(process.env.CLOSE_LIVE_REPORT, JSON.stringify(report, null, 2) + '\n');
  rmSync(root, { recursive: true, force: true });
}
console.log(`ALL PASS (${report.checks.length} live checks), private Rex cleanup verified`);
