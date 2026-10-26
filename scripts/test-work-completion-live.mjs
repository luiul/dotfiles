#!/usr/bin/env node
/** Isolated Pi 1.4 TUI checks with a local provider. Run: node scripts/test-work-completion-live.mjs */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidate = join(repo, 'pi/.pi/agent/extensions/work-completion.ts');
const fixture = join(repo, 'scripts/fixtures/work-completion-live.ts');
const cli = process.env.WC_LIVE_PI_CLI ?? join(homedir(), '.pi/agent/install/current/node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
const realBin = process.env.WC_LIVE_REAL_BIN ?? join(repo, 'git/.local/bin/repo-guard');
const statusBar = join(repo, 'pi/.pi/agent/extensions/status-bar.ts');
for (const path of [candidate, fixture, cli]) assert(existsSync(path), `Missing ${path}`);
const root = realpathSync(mkdtempSync(join(tmpdir(), 'work-completion-live-')));
const owned = new Map();
const deadline = Date.now() + 4 * 60_000;
const original = readFileSync(candidate, 'utf8');
const checks = [];
const q = (v) => `'${String(v).replaceAll("'", "'\\''")}'`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, fn) { fn(); checks.push(name); console.log(`PASS ${name}`); }
function run(file, args, optional = false) {
  try { return execFileSync(file, args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { if (optional) return ''; throw new Error(`${file}: ${error.stderr ?? error.message}`); }
}
const tmux = (...args) => run('tmux', args);
const git = run('which', ['git']).trim();
const guard = join(root, 'fake-guard.mjs');
writeFileSync(guard, `import fs from 'node:fs'; import path from 'node:path';
fs.appendFileSync(process.env.WC_GUARD_CALLS,JSON.stringify(process.argv.slice(2))+'\\n');
if(JSON.stringify(process.argv.slice(2,5))!==JSON.stringify(['status','--json','--cwd'])) throw Error('status only');
const root=process.argv[5];
console.log(JSON.stringify({root,commonDir:path.join(root,'.git'),branch:'main',head:'fixture-head',dirty:['old.txt',...(fs.existsSync(path.join(root,'new.txt'))?['new.txt']:[])].map(path=>({path,status:' M'})),upstream:null,ahead:null,behind:null,defaultBranch:'main',isHelloFresh:false,publication:'unknown',operation:false}));\n`);
const bin = join(root, 'bin'); mkdirSync(bin);
const gitShim = join(bin, 'git');
writeFileSync(gitShim, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$WC_GIT_CALLS"\nfor arg in "$@"; do\n  case "$arg" in commit|push|fetch|pull|ls-remote|clone) exit 97;; esac\ndone\nexec ${q(git)} "$@"\n`, { mode: 0o755 });
let seq = 0;
function lines(file) { return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((v) => JSON.parse(v)) : []; }
const gitCalls = (h) => existsSync(h.gitCalls) ? readFileSync(h.gitCalls, 'utf8').trim().split('\n').filter(Boolean).map((s) => s.split(' ')) : [];
const events = (h) => lines(h.events);
const capture = (h) => tmux('capture-pane', '-p', '-t', h.name);
function head(h) { return run(git, ['-C', h.dir, 'rev-parse', 'HEAD']).trim(); }
function last(h) { return events(h).filter((e) => e.type === 'append').at(-1)?.data; }
async function wait(h, predicate, description, ms = 20_000) {
  const until = Math.min(Date.now() + ms, deadline); let screen = '';
  while (Date.now() < until) {
    screen = capture(h); const list = events(h);
    assert(!/Extension error|Failed to load extension|TypeError:|Error in render|exceeds terminal width/.test(screen), screen);
    assert(!list.some((e) => e.type === 'forbidden' || e.type === 'fixture-error'), JSON.stringify(list));
    if (predicate(screen, list)) return screen;
    await sleep(100);
  }
  throw new Error(`Timed out: ${description}\n${screen}\n${JSON.stringify(events(h).slice(-8))}`);
}
async function command(h, text) {
  tmux('send-keys', '-t', h.name, 'C-u'); tmux('send-keys', '-t', h.name, '-l', text); tmux('send-keys', '-t', h.name, 'Enter');
  await sleep(150);
}
async function prompt(h, text) {
  const n = events(h).filter((e) => e.type === 'settled').length;
  await command(h, text);
  return wait(h, (_s, list) => list.filter((e) => e.type === 'settled').length > n, text);
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function stop(h) {
  run('tmux', ['send-keys', '-t', h.name, 'C-u', 'C-d'], true);
  const until = Date.now() + 2000;
  while (h.pid && alive(h.pid) && Date.now() < until) await sleep(100);
  run('tmux', ['kill-session', '-t', h.name], true);
  if (h.pid && alive(h.pid)) { try { process.kill(h.pid, 'SIGTERM'); } catch {} await sleep(200); }
  if (h.pid && alive(h.pid)) { try { process.kill(h.pid, 'SIGKILL'); } catch {} await sleep(100); }
}
async function start(label, script, withStatusBar = false) {
  const area = join(root, `host-${++seq}`); mkdirSync(area);
  const dir = join(area, 'repo'); mkdirSync(dir);
  run(git, ['init', '-b', 'main', dir]);
  // An origin URL without remote refs keeps publication unknown. The test never contacts it.
  run(git, ['-C', dir, 'remote', 'add', 'origin', join(root, 'never-contacted.git')]);
  writeFileSync(join(dir, 'old.txt'), 'baseline\n');
  run(git, ['-C', dir, 'add', 'old.txt']);
  run(git, ['-C', dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@local.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'test fixture baseline']);
  writeFileSync(join(dir, 'old.txt'), 'preexisting change\n');
  const config = join(area, 'agent'); mkdirSync(config);
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ quietStartup: true, theme: 'dark', defaultProvider: 'wc-live', defaultModel: 'fixture', compaction: { enabled: false }, retry: { enabled: false } }));
  const h = { name: `ag-wc-${process.pid}-${seq}`, dir, area, events: join(area, 'events.jsonl'), guardCalls: join(area, 'guard.jsonl'), gitCalls: join(area, 'git.jsonl'), pid: null };
  h.head = head(h); h.preexisting = readFileSync(join(dir, 'old.txt'), 'utf8');
  h.env = { HOME: homedir(), PATH: `${bin}:${process.env.PATH}`, TERM: 'xterm-256color', LANG: 'en_US.UTF-8',
    PI_CODING_AGENT_DIR: config, PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', PI_OFFLINE: '1', PI_IMAGE_PROTOCOL: 'none',
    WC_LIVE_EVENTS: h.events, WC_LIVE_EXTENSION: candidate, PI_REPO_GUARD_BIN: script, WC_GUARD_CALLS: h.guardCalls, WC_GIT_CALLS: h.gitCalls };
  if (script === realBin) {
    const probe = spawnSync(process.execPath, [script, 'status', '--json', '--cwd', dir], { cwd: dir, env: h.env, encoding: 'utf8', timeout: 6000 });
    assert.equal(probe.status, 0, `Actual CLI preflight: ${probe.stdout} ${probe.stderr}`);
    rmSync(h.gitCalls, { force: true });
  }
  h.args = [cli, '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-approve', '--no-mcp', '--no-themes',
    '--thinking', 'off', '--provider', 'wc-live', '--model', 'fixture', '--tui-mode', 'fullscreen', '--use-theme', 'dark', '--session-dir', join(area, 'sessions'), '-e', fixture,
    ...(withStatusBar ? ['-e', statusBar] : [])];
  const launch = `cd ${q(dir)} && exec env -i ${Object.entries(h.env).map(([k, v]) => q(`${k}=${v}`)).join(' ')} ${[process.execPath, ...h.args].map(q).join(' ')}`;
  tmux('new-session', '-d', '-s', h.name, '-x', '100', '-y', '28', '/bin/sleep 240'); owned.set(h.name, h);
  run('reap-strays', ['--register-tmux', h.name, '--owner', String(process.pid), '--deadline', String(Math.ceil(deadline / 1000))]);
  tmux('respawn-pane', '-k', '-t', h.name, launch);
  await wait(h, (s, list) => list.some((e) => e.type === 'ready') && /Work pending: 1 changed/.test(s), label + ' startup');
  h.pid = events(h).find((e) => e.type === 'ready').pid;
  return h;
}
async function behavior(label, script) {
  const h = await start(label, script);
  try {
    check(`${label}: explicit extension in isolated TUI, initial baseline pending without warning`, () => {
      assert.deepEqual(events(h).find((e) => e.type === 'ready').commands.sort(), ['work-status', 'wc-live-draft'].sort());
      assert.equal(events(h).find((e) => e.type === 'ready').mode, 'tui');
      assert.equal(last(h).baseline.dirty.length, 1); assert.equal(last(h).changedObserved, false);
      assert.equal(events(h).filter((e) => e.type === 'ui-notify').length, 0);
      assert.match(capture(h), /1 present at start/);
    });
    await prompt(h, 'WC_CREATE');
    check(`${label}: real write tool with unchanged HEAD adds pending work without blaming preexisting dirt`, () => {
      assert.equal(readFileSync(join(h.dir, 'new.txt'), 'utf8'), 'test change\n');
      assert.equal(head(h), h.head); assert.equal(last(h).baseline.dirty.length, 1);
      assert.equal(last(h).lastStatus.dirty.length, 2); assert.equal(last(h).changedObserved, true);
      assert.match(capture(h), /2 changed \(1 present at start\)/);
      assert.equal(events(h).filter((e) => e.type === 'ui-notify').length, 1);
    });
    const appends = events(h).filter((e) => e.type === 'append').length;
    await prompt(h, 'WC_NO_EDIT');
    check(`${label}: repeated settlement has no duplicate reminder or state write`, () => {
      assert.equal(events(h).filter((e) => e.type === 'ui-notify').length, 1);
      assert.equal(events(h).filter((e) => e.type === 'append').length, appends);
    });
    const responses = events(h).filter((e) => e.type === 'response').length;
    await command(h, '/work-status');
    await wait(h, (s) => /Deployment not checked/.test(s), 'explicit notice');
    check(`${label}: command shows root, branch, baseline counts and unknown publication without model call`, () => {
      const s = capture(h); assert.match(s, /Dirty: 1 at start, 2 now/); assert.match(s, /Publication: unknown/);
      assert.match(s, /\(main\)/);
      const notice = events(h).filter((e) => e.type === 'ui-notify').at(-1).args[0];
      assert(notice.includes(h.dir), 'The UI notice must include the untruncated source root');
      assert.equal(events(h).filter((e) => e.type === 'response').length, responses);
    });
    const ready = events(h).filter((e) => e.type === 'ready').length;
    await command(h, '/reload');
    await wait(h, (_s, list) => list.filter((e) => e.type === 'ready').length > ready, 'reload');
    check(`${label}: reload restores original baseline and changedObserved without duplicate append`, () => {
      assert.equal(last(h).baseline.dirty.length, 1); assert.equal(last(h).changedObserved, true);
      assert.equal(events(h).filter((e) => e.type === 'append').length, appends);
      assert.match(capture(h), /2 changed \(1 present at start\)/);
    });
    await command(h, '/wc-live-draft');
    await wait(h, (_s, list) => list.some((e) => e.type === 'draft-after'), 'draft');
    check(`${label}: status leaves editor draft and model request count unchanged`, () => {
      assert.equal(events(h).find((e) => e.type === 'draft-after').text, 'DRAFT keep this text');
      assert.equal(events(h).filter((e) => e.type === 'response').length, responses);
    });
    tmux('send-keys', '-t', h.name, 'C-u');
    tmux('resize-window', '-t', h.name, '-x', '40', '-y', '24');
    await wait(h, (s) => s.split('\n').some((l) => l.startsWith('Work pending:')), 'narrow widget');
    check(`${label}: real 40-column widget stays one physical line`, () => {
      const widget = capture(h).split('\n').filter((l) => l.startsWith('Work pending:'));
      assert.equal(widget.length, 1); assert(widget[0].length <= 40);
    });
    const session = events(h).filter((e) => e.type === 'settled').at(-1).session;
    const data = lines(session).filter((e) => e.type === 'custom' && e.customType === 'work-completion:state').at(-1).data;
    check(`${label}: durable custom state is excluded from model messages and baseline survives reload`, () => {
      assert.equal(data.baseline.dirty.length, 1); assert.equal(data.lastStatus.dirty.length, 2); assert(data.changedObserved);
      assert(!lines(session).some((e) => e.type === 'message' && e.message?.role === 'custom'));
    });
    check(`${label}: no automatic commit, publication check, network Git or UI dialog`, () => {
      assert.equal(head(h), h.head); assert.equal(readFileSync(join(h.dir, 'old.txt'), 'utf8'), h.preexisting);
      assert(!events(h).some((e) => ['forbidden', 'ui-confirm', 'ui-custom', 'ui-setEditorText'].includes(e.type)));
      for (const args of lines(h.guardCalls)) assert.deepEqual(args, ['status', '--json', '--cwd', h.dir]);
      for (const args of gitCalls(h)) assert(!args.some((a) => ['push', 'fetch', 'pull', 'commit', 'ls-remote', 'clone'].includes(a)));
    });
    const calls = lines(h.guardCalls).length, gitCount = gitCalls(h).length;
    await sleep(600);
    check(`${label}: no idle scan timer or render Git`, () => { assert.equal(lines(h.guardCalls).length, calls); assert.equal(gitCalls(h).length, gitCount); });
    await stop(h);
    check(`${label}: shutdown performs no scans or dialogs`, () => {
      assert(events(h).some((e) => e.type === 'shutdown')); assert.equal(lines(h.guardCalls).length, calls); assert.equal(gitCalls(h).length, gitCount);
    });
    // Headless child loads the same candidate and provider but cannot own work state.
    const childEvents = join(h.area, 'child.jsonl');
    const child = spawnSync(process.execPath, [...h.args, '--mode', 'json', '-p', 'WC_NO_EDIT'], {
      cwd: h.dir, env: { ...h.env, WC_LIVE_EVENTS: childEvents }, encoding: 'utf8', timeout: 20_000,
    });
    check(`${label}: real JSON child has no reminder writes, UI or scans`, () => {
      assert.equal(child.status, 0, child.stderr);
      assert(lines(childEvents).some((e) => e.type === 'response'));
      assert(!lines(childEvents).some((e) => e.type === 'append' || e.type.startsWith('ui-')));
      assert.equal(lines(h.guardCalls).length, calls); assert.equal(gitCalls(h).length, gitCount);
    });
  } finally { await stop(h); }
}
try {
  await behavior('fixture CLI', guard);
  if (existsSync(realBin)) await behavior('actual CLI', realBin);
  else console.log(`SKIP actual candidate CLI not available: ${realBin}`);
  const barHost = await start('configured status bar', guard, true);
  try {
    tmux('resize-window', '-t', barHost.name, '-x', '40', '-y', '24');
    const screen = await wait(barHost, (s) => s.split('\n').some((line) => line.startsWith('Work pending:')), 'configured narrow status bar');
    check('configured narrow status bar can hide footer status but reminder widget stays visible', () => {
      assert.equal(screen.split('\n').filter((line) => line.startsWith('Work pending:')).length, 1);
      assert(!screen.includes('Work: 1 changed; /work-status'));
      assert.equal(events(barHost).filter((e) => e.type === 'ui-notify').length, 0);
    });
  } finally { await stop(barHost); }
} finally {
  for (const h of owned.values()) {
    h.pid ??= events(h).find((e) => e.type === 'ready')?.pid;
    await stop(h);
  }
  check('owned Pi processes and tmux sessions removed', () => {
    for (const h of owned.values()) { assert(!h.pid || !alive(h.pid)); assert(!run('tmux', ['has-session', '-t', h.name], true)); }
    const sessions = run('tmux', ['list-sessions', '-F', '#{session_name}'], true);
    assert(!sessions.includes(`ag-wc-${process.pid}-`));
  });
  rmSync(root, { recursive: true, force: true });
  check('temporary test data removed and candidate unchanged by tests', () => { assert(!existsSync(root)); assert.equal(readFileSync(candidate, 'utf8'), original); });
}
console.log(`Checks: ${checks.length} passed`);
