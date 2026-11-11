#!/usr/bin/env node
/** Seeded compact tool calls in private Rex. The default run cannot call a model.
 * Optional paid turn needs ZEN_E2E_LIVE=1, ZEN_E2E_ALLOW_MODEL_CALL=1,
 * ZEN_E2E_LIVE_MODELS=/path/to/explicit-models.json, ZEN_E2E_LIVE_PROVIDER,
 * and ZEN_E2E_LIVE_MODEL. Credentials must be in that explicit fixture file.
 * Never copy the user's agent directory or auth store.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { RexTestDriver } from './rex-test-driver.mjs';

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const candidate = join(repo, 'pi/.pi/agent/extensions/zen.ts');
const install = join(homedir(), '.pi/agent/install');
export const version = readFileSync(join(install, 'current-version'), 'utf8').trim();
assert(/^[\w.-]+$/.test(version), 'Invalid managed Pi release');
const pkg = join(install, 'releases', version, 'node_modules/@earendil-works/pi-coding-agent');
export const cli = join(pkg, 'dist/cli.js');
assert.equal(JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version, version);
assert(existsSync(cli) && existsSync(candidate), 'Managed Pi or zen source missing');
assert(!process.versions.bun, 'Run this harness with native Node');
export const pause = ms => new Promise(done => setTimeout(done, ms));
const fixtureProvider = 'zen-seed';
const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export function seed(file, cwd) {
  const timestamp = n => `2026-10-26T00:00:${String(n).padStart(2, '0')}.000Z`;
  const message = (id, parentId, n, role, content, extra = {}) => ({ type: 'message', id, parentId,
    timestamp: timestamp(n), message: { role, content, timestamp: Date.parse(timestamp(n)), ...extra } });
  const assistant = (id, parent, n, content, stopReason) => message(id, parent, n, 'assistant', content,
    { api: 'zen-seed-blocked', provider: fixtureProvider, model: 'fixture', usage, stopReason });
  const records = [
    { type: 'session', version: 3, id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', timestamp: timestamp(0), cwd },
    { type: 'model_change', id: 'm1', parentId: null, timestamp: timestamp(0), provider: fixtureProvider, modelId: 'fixture' },
    message('u1', 'm1', 1, 'user', [{ type: 'text', text: 'list the files and say hello' }]),
    assistant('a1', 'u1', 2, [{ type: 'thinking', thinking: 'The user wants a file listing and a greeting. I will run ls via the bash tool, keep it short, and say hello.' },
      { type: 'text', text: 'I will take a look at the files first.' }], 'stop'),
    assistant('a2', 'a1', 3, [{ type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'ls -la' } }], 'toolUse'),
    message('r1', 'a2', 4, 'toolResult', [{ type: 'text', text: 'total 8\n-rw-r--r--  1 luis  staff   64 Oct 26 00:00 ZENOUT-MARKER.txt' }], { toolCallId: 'tc1', toolName: 'bash', isError: false }),
    assistant('a3', 'r1', 5, [{ type: 'toolCall', id: 'tc2', name: 'bash', arguments: { command: 'cat missing.txt' } }], 'toolUse'),
    message('r2', 'a3', 6, 'toolResult', [{ type: 'text', text: 'cat: missing.txt: No such file or directory' }], { toolCallId: 'tc2', toolName: 'bash', isError: true }),
    assistant('a4', 'r2', 7, [{ type: 'thinking', thinking: 'The file was missing, an error. I should report the failure clearly and offer the successful listing.' },
      { type: 'text', text: 'Hello! The listing worked and shows a marker file. The second command failed because missing.txt does not exist.' }], 'stop'),
  ];
  writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
}

/** A passive readiness probe shared by all variants, plus a provider that refuses
 * every request. --offline alone blocks startup traffic, not model turns.
 */
function writeProbe(file) {
  writeFileSync(file, `import {appendFileSync} from 'node:fs';
export default function(pi) {
 const note=(type,data={})=>appendFileSync(process.env.ZEN_SEED_EVENTS,JSON.stringify({type,pid:process.pid,...data})+'\\n');
 if(process.env.ZEN_SEED_PAID!=='1') pi.registerProvider('${fixtureProvider}',{
  api:'zen-seed-blocked',baseUrl:'http://local.invalid',apiKey:'no-network-fixture',
  models:[{id:'fixture',name:'Zen Seed Fixture',reasoning:true,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:1024}],
  streamSimple(){note('forbidden-model-call');throw new Error('Seeded test must not call a model');}
 });
 pi.on('session_start',(_event,ctx)=>note('ready',{session:ctx.sessionManager.getSessionFile(),mode:ctx.mode}));
 pi.on('session_shutdown',()=>note('shutdown'));
 pi.on('agent_settled',()=>note('settled'));
}
`);
}
export const events = host => existsSync(host.events) ? readFileSync(host.events, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
export const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
export function inspect(driver, host) {
  const screen = driver.capture(host);
  assert(!/Extension.*(?:error|failed|cannot)|Failed to load extension|TypeError:|ReferenceError:|Error in render|exceeds terminal width/i.test(screen), `Host error:\n${screen}`);
  assert(!events(host).some(e => e.type === 'forbidden-model-call'), 'Unexpected model call');
  assert(!driver.process(host).last_exit && (!host.pid || alive(host.pid)), `Pi exited:\n${screen}`);
  return screen;
}
export async function wait(driver, host, predicate, label, deadline, timeout = 30_000) {
  const until = Math.min(Date.now() + timeout, deadline);
  let last = '';
  while (Date.now() < until) {
    last = inspect(driver, host);
    if (predicate(last, events(host))) return last;
    await pause(100);
  }
  throw new Error(`Timed out ${label}:\n${last}`);
}
export async function stable(driver, host, deadline) {
  let previous;
  let matches = 0;
  return wait(driver, host, screen => {
    matches = screen === previous ? matches + 1 : 0;
    previous = screen;
    return matches >= 2;
  }, 'stable viewport', deadline, 8000);
}
export function command(driver, host, text) {
  // Only local commands are accepted unless the caller explicitly enabled paid input.
  assert(host.paid || ['/zen', '/zen off', '/zen on', '/reload'].includes(text), 'Unsafe fixture input');
  driver.key(host, 'ctrl+u'); driver.text(host, text); driver.key(host, 'enter');
}
export async function start(driver, { variant = 'zen', mode = 'seeded', sequence = 1, deadline, paid } = {}) {
  assert(['bare', 'off', 'zen', 'zen1', 'zen2'].includes(variant), `Unknown variant: ${variant}`);
  assert(['startup', 'seeded'].includes(mode), `Unknown mode: ${mode}`);
  const area = join(driver.root, `zen-${sequence}`), home = join(area, 'home');
  const agent = join(home, '.pi/agent'), sessions = join(agent, 'sessions');
  const cwd = join(driver.root, 'zen-cwd');
  mkdirSync(sessions, { recursive: true }); mkdirSync(cwd, { recursive: true });
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({ quietStartup: true, theme: 'dark', tuiMode: 'fullscreen',
    defaultProvider: paid?.provider ?? fixtureProvider, defaultModel: paid?.model ?? 'fixture', hideThinkingBlock: true,
    cacheWarming: 'off', enableAnalytics: false, enableInstallTelemetry: false, retry: { enabled: false },
    compaction: { enabled: false }, shellPath: '/bin/bash' }));
  // The paid branch reads only the explicitly supplied fixture, never live HOME auth.
  if (paid) writeFileSync(join(agent, 'models.json'), paid.models);
  const config = join(agent, 'zen.json'), eventFile = join(area, 'events.jsonl'), probe = join(area, 'probe.ts');
  writeProbe(probe);
  const seedFile = join(sessions, 'seed.jsonl');
  if (mode === 'seeded') seed(seedFile, cwd);
  const args = [process.execPath, cli, '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates',
    '--no-context-files', '--no-approve', '--no-mcp', '--no-themes', '--use-theme', 'dark', '--tui-mode', 'fullscreen',
    '--provider', paid?.provider ?? fixtureProvider, '--model', paid?.model ?? 'fixture', '--session-dir', sessions,
    ...(mode === 'seeded' ? ['--session', seedFile] : []), '-e', probe,
    ...(variant === 'bare' ? [] : ['-e', candidate, variant === 'off' ? '--no-zen' : '--zen'])];
  const launched = performance.now();
  const host = { area, home, config, events: eventFile, paid: !!paid, variant, mode,
    ...driver.create({ name: `ag-zen-seed-${process.pid}-${sequence}`, command: args, cwd, columns: 120, rows: 44,
      env: { HOME: home, PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8',
        PI_CODING_AGENT_DIR: agent, PI_SKIP_VERSION_CHECK: '1', PI_OFFLINE: '1', PI_IMAGE_PROTOCOL: 'none', PI_PROGRAM_STATUS: '0',
        ZEN_SEED_EVENTS: eventFile, ZEN_SEED_PAID: paid ? '1' : '0' } }) };
  // Measure from before Rex target creation. This includes its login wrapper and
  // target registration overhead, but not private server startup or seed creation.
  await wait(driver, host, (screen, list) => list.some(e => e.type === 'ready') &&
    /\d+(?:\.\d+)?%\//.test(screen) && (mode !== 'seeded' || screen.includes('Hello! The listing worked')),
  'first ready paint', deadline);
  host.pid = driver.pid(host);
  assert.equal(events(host).find(e => e.type === 'ready').pid, host.pid, 'Recorded PID must be the Pi target');
  assert(events(host).find(e => e.type === 'ready').session.startsWith(sessions), 'Session escaped private HOME');
  await stable(driver, host, deadline);
  host.startupMs = performance.now() - launched;
  return host;
}
export async function stop(driver, host) {
  if (host.closed) return;
  if (alive(host.pid)) { driver.key(host, 'escape'); driver.key(host, 'ctrl+u'); driver.key(host, 'ctrl+d'); }
  const until = Date.now() + 5000;
  while (alive(host.pid) && Date.now() < until) await pause(100);
  assert(!alive(host.pid), `Pi target did not exit: ${host.pid}`);
  driver.close(host); host.closed = true;
}
function compact(screen) {
  const lines = screen.split('\n');
  const success = lines.filter(line => line.includes('$ ls -la'));
  const failure = lines.filter(line => line.includes('$ cat missing.txt'));
  assert.equal(success.length, 1, 'Success call must occupy one physical row');
  assert.match(success[0], /\$ ls -la\s+✓/);
  assert.equal(failure.length, 1, 'Failed call must occupy one physical row');
  assert.match(failure[0], /\$ cat missing\.txt\s+✗ cat: missing\.txt: No such file or directory/);
  assert(!screen.includes('ZENOUT-MARKER'), 'Compact success leaked output');
  assert(screen.includes('Thinking...'), 'Native collapsed thinking label missing');
  assert(!screen.includes('The user wants a file listing'), 'Thinking leaked');
  assert(screen.includes('Hello! The listing worked'), 'Conversation text missing');
}
function parity(screen) {
  // Only known volatile notices are removed. Keep every transcript, editor and
  // footer row. Both hosts share cwd, size, theme, provider and the same seed.
  return screen.split('\n').map(line => line.trimEnd()).filter(line =>
    line.trim() && !/ zen: |Could not restore model|tmux extended-keys/.test(line)).join('\n');
}
async function main() {
  let paid;
  if (process.env.ZEN_E2E_LIVE === '1') {
    assert.equal(process.env.ZEN_E2E_ALLOW_MODEL_CALL, '1', 'Paid test needs a second explicit opt-in');
    const { ZEN_E2E_LIVE_MODELS: modelsFile, ZEN_E2E_LIVE_PROVIDER: provider, ZEN_E2E_LIVE_MODEL: model } = process.env;
    assert(modelsFile && provider && model, 'Paid test needs an explicit models fixture, provider and model');
    assert(resolve(modelsFile) !== join(homedir(), '.pi/agent/models.json'), 'Do not use the live models store');
    paid = { models: readFileSync(modelsFile, 'utf8'), provider, model };
    JSON.parse(paid.models);
  }
  const deadline = Date.now() + 240_000;
  let driver, host, checks = 0;
  const pass = label => { checks++; console.log(`PASS ${label}`); };
  try {
    driver = await RexTestDriver.start({ deadlineMs: 270_000 });
    host = await start(driver, { deadline });
    assert(alive(host.pid)); pass('private session alive, clean startup');
    compact(inspect(driver, host)); pass('single-row success and failure, suffixes, collapsed thinking, intact text');
    driver.key(host, 'ctrl+o');
    await wait(driver, host, screen => screen.includes('ZENOUT-MARKER'), 'Ctrl+O expands success output', deadline);
    pass('Ctrl+O shows native output');
    driver.key(host, 'ctrl+o');
    await wait(driver, host, screen => !screen.includes('ZENOUT-MARKER') && screen.includes('✓'), 'Ctrl+O collapses', deadline);
    compact(await stable(driver, host, deadline)); pass('Ctrl+O collapse restores compact row and suffix');
    command(driver, host, '/zen');
    await wait(driver, host, screen => screen.includes('ZENOUT-MARKER'), 'zen off native output', deadline);
    assert.equal(JSON.parse(readFileSync(host.config, 'utf8')).filter, false); pass('toggle off restores native output, writes private config');
    command(driver, host, '/zen');
    await wait(driver, host, screen => !screen.includes('ZENOUT-MARKER') && screen.includes('✓'), 'zen on', deadline);
    compact(await stable(driver, host, deadline));
    assert.equal(JSON.parse(readFileSync(host.config, 'utf8')).filter, true); pass('toggle on restores compact transcript');
    const before = events(host).filter(e => e.type === 'ready').length;
    const session = events(host).find(e => e.type === 'ready').session;
    command(driver, host, '/reload');
    await wait(driver, host, (screen, list) => list.filter(e => e.type === 'ready').length > before && screen.includes('$ ls -la'), 'reload', deadline);
    compact(await stable(driver, host, deadline));
    assert.equal(events(host).filter(e => e.type === 'ready').at(-1).session, session);
    assert.equal(JSON.parse(readFileSync(host.config, 'utf8')).filter, true); pass('reload preserves session and compact state');
    await stop(driver, host);
    host = await start(driver, { variant: 'off', sequence: 2, deadline });
    const off = parity(await stable(driver, host, deadline));
    assert(off.includes('ZENOUT-MARKER'), 'Off parity must contain real native output');
    await stop(driver, host);
    host = await start(driver, { variant: 'bare', sequence: 3, deadline });
    assert.equal(parity(await stable(driver, host, deadline)), off, 'Zen off and bare Pi must match line for line');
    pass('zen off equals bare Pi, line for line');
    await stop(driver, host);
    if (paid) {
      host = await start(driver, { mode: 'startup', sequence: 4, deadline, paid });
      command(driver, host, "use the bash tool to run 'echo zen-live-e2e', then answer with one short sentence");
      const screen = await wait(driver, host, (screen, list) => list.some(e => e.type === 'settled') &&
        /\$ echo zen-live-e2e.*✓/.test(screen) && screen.includes('zen-live-e2e'), 'paid live turn', deadline, 90_000);
      assert.equal(screen.split('\n').filter(line => /\$ echo zen-live-e2e.*✓/.test(line)).length, 1);
      const callRow = screen.split('\n').findIndex(line => /\$ echo zen-live-e2e.*✓/.test(line));
      assert(screen.split('\n').slice(callRow + 1).some(line => /zen-live-e2e/i.test(line)), 'Live answer missing');
      assert(alive(host.pid)); pass('optional live call, suffix, answer and surviving session');
      await stop(driver, host);
    } else console.log('SKIP paid live turn, explicit double opt-in and separate model fixture required');
  } finally {
    // The shared driver owns identity-checked forced cleanup, including partial
    // startup failures. Do not discover or signal anyone else's processes.
    if (driver) {
      const root = driver.root;
      const result = await driver.stop();
      assert(result?.clean && !existsSync(root), 'Private Rex cleanup unresolved');
      if (host?.pid) assert(!alive(host.pid), 'Owned Pi survives cleanup');
      pass('private server, targets, config and sessions removed');
    }
  }
  console.log(`Zen seeded Rex: ${checks} checks passed, Pi ${version}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
