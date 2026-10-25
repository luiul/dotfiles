#!/usr/bin/env node
// Only an isolated tmux socket and test-owned processes are eligible for cleanup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { configuration, createPs, createTmux, processClass, registerTmux, runReaper } from '../macos/.local/bin/reap-strays.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-live-'));
const socket = `ag-reaper-test-${process.pid}`;
const name = `ag-reaper-test-${process.pid}`;
const binary = execFileSync('/usr/bin/which', ['tmux'], { encoding: 'utf8' }).trim();
const owned = [];
function own(command, args, options = {}) {
  const child = spawn(command, args, { stdio: 'ignore', ...options });
  const done = new Promise(resolve => {
    child.once('exit', resolve);
    child.once('error', resolve);
  });
  const ready = new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  owned.push({ child, done, ready });
  return child;
}
const owner = own(process.execPath, ['-e', 'setTimeout(()=>{},60000)']);
const call = args => execFileSync(binary, ['-L', socket, ...args], { encoding: 'utf8', timeout: 5000 });
const config = configuration(temp);
// Do not classify any real orphan process during the tmux integration test.
const tmuxConfig = { ...config, shells: new Set(), runtimes: new Set(), gitstatus: path.join(temp, 'no-gitstatus') };
const ps = createPs();
const tmux = createTmux(ps, fs, (command, args, env) => {
  const redirected = [...args];
  assert.deepEqual(redirected.slice(0, 2), ['-L', 'default']);
  redirected[1] = socket;
  return spawnSync(command, redirected, { env, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
});
const output = [];
const dependencies = { config: tmuxConfig, ps, tmux, write: line => output.push(line) };
const stopOwned = () => {
  for (const { child } of owned) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
};
const bound = setTimeout(() => {
  stopOwned();
  try { call(['kill-server']); } catch {}
}, 30_000);
let started = false;
let serverPid;
try {
  // Keep real shells waiting for stdin. Skip user/global startup files, with a private ZDOTDIR.
  const shellOptions = { env: { ...process.env, ZDOTDIR: temp }, stdio: ['pipe', 'pipe', 'pipe'] };
  const login = own('/bin/zsh', ['-df', '-l'], shellOptions);
  const loginName = own('/bin/zsh', ['-df'], { ...shellOptions, argv0: '-zsh' });
  const interactive = own('/bin/zsh', ['-dfil'], shellOptions);
  for (const child of [login, loginName, interactive]) {
    child.stdout.resume(); child.stderr.resume();
    await owned.find(entry => entry.child === child).ready;
  }
  const seconds = Math.floor(Date.now() / 1000);
  // Use real ps executable/argv/tty, but synthetic orphan age/parent to exercise classification now.
  // Signal calls below are spies. No process receives a reaper signal.
  const candidate = child => {
    const actual = ps.get(child.pid);
    assert.ok(actual); assert.equal(actual.ppid, process.pid);
    assert.ok(['??', '?', '-'].includes(actual.tty));
    return { ...actual, ppid: 1, start: seconds - 1200 };
  };
  const shellRows = [login, loginName, interactive].map(candidate);
  assert.equal(processClass(shellRows[0], config, seconds), null);
  assert.equal(processClass(shellRows[1], config, seconds), null);
  assert.equal(processClass(shellRows[2], config, seconds), 'zsh');
  const attempted = [];
  const isolated = {
    config, clock: () => seconds, lockPs: ps,
    ps: { snapshot: () => shellRows, get: pid => candidate([login, loginName, interactive].find(child => child.pid === pid)) },
    signal: (pid, sig) => { attempted.push([pid, sig]); return true; },
    tmux: { snapshot: () => ({ sessions: [], available: false }) }, write: () => {},
  };
  runReaper({ apply: true }, isolated);
  assert.deepEqual(attempted, [[interactive.pid, 'SIGTERM']]);
  for (const child of [login, loginName]) {
    let text = '';
    child.stdout.on('data', data => { text += data; });
    child.stdin.end('print -r -- reaper-stdin-script-ok\n');
    await owned.find(entry => entry.child === child).done;
    assert.equal(child.exitCode, 0); assert.ok(text.includes('reaper-stdin-script-ok'));
  }
  console.log('PASS real login-only stdin scripts stay usable; explicit interactive argv matches with spy signals');

  const ambiguousPath = `${config.bundle} backup.mjs`;
  fs.mkdirSync(path.dirname(ambiguousPath), { recursive: true });
  fs.writeFileSync(ambiguousPath, 'setTimeout(()=>{},60000);\n');
  const ambiguous = own(process.execPath, [ambiguousPath]);
  await owned.find(entry => entry.child === ambiguous).ready;
  const bridge = candidate(ambiguous);
  assert.ok(bridge.args.includes(ambiguousPath));
  assert.equal(processClass(bridge, config, seconds), null);
  runReaper({ apply: true }, { ...isolated, ps: { snapshot: () => [bridge], get: () => candidate(ambiguous) } });
  assert.deepEqual(attempted, [[interactive.pid, 'SIGTERM']]);
  assert.equal(ambiguous.exitCode, null); assert.equal(ambiguous.signalCode, null);
  console.log('PASS real Node entrypoint with embedded space is skipped');

  call(['new-session', '-d', '-s', name, '-x', '80', '-y', '24', 'sleep 60']); started = true;
  serverPid = Number(call(['display-message', '-p', '#{pid}']).trim());
  assert.ok(Number.isSafeInteger(serverPid) && serverPid > 1);
  const deadline = Math.floor(Date.now() / 1000) + 3;
  const registration = registerTmux({ name, pid: owner.pid, deadline }, dependencies);
  assert.ok(registration.owner.startsWith(`${owner.pid}:`));
  await delay(Math.max(0, deadline * 1000 - Date.now()) + 200);
  const live = runReaper({ apply: true, report: true }, dependencies);
  assert.equal(live.tmux.eligible, 0);
  assert.ok(output.some(line => line.includes('live-owner')));
  assert.equal(call(['has-session', '-t', name]), '');
  console.log('PASS real expired tmux task stays intact while owner is alive');
  owner.kill('SIGTERM');
  await owned.find(entry => entry.child === owner).done;
  const dead = runReaper({ apply: true, report: true }, dependencies);
  assert.equal(dead.tmux.eligible, 1); assert.equal(dead.tmux.failed, 0);
  const state = spawnSync(binary, ['-L', socket, 'has-session', '-t', name], { encoding: 'utf8', timeout: 5000 });
  assert.notEqual(state.status, 0);
  assert.ok(output.some(line => line.startsWith('Killed tmux')));
  console.log('PASS real expired private tmux task is removed after its owner exits');
} finally {
  stopOwned();
  await Promise.all(owned.map(entry => entry.done));
  if (started) { try { call(['kill-server']); } catch {} }
  clearTimeout(bound);
  if (serverPid) {
    for (let attempt = 0; attempt < 20 && ps.get(serverPid); attempt++) await delay(100);
    assert.equal(ps.get(serverPid), null, 'private tmux server must be gone');
  }
  for (const { child } of owned) {
    if (child.pid) assert.equal(ps.get(child.pid), null, `test-owned process ${child.pid} must be gone`);
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('ALL PASS 4 isolated live checks; test-owned processes and private tmux server exited');
