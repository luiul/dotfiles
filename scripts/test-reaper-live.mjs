#!/usr/bin/env node
// Only an isolated tmux socket and test-owned process are eligible for cleanup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { configuration, createPs, createTmux, registerTmux, runReaper } from '../macos/.local/bin/reap-strays.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-live-'));
const socket = `ag-reaper-test-${process.pid}`;
const name = `ag-reaper-test-${process.pid}`;
const binary = execFileSync('/usr/bin/which', ['tmux'], { encoding: 'utf8' }).trim();
const owner = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
const call = (args) => execFileSync(binary, ['-L', socket, ...args], { encoding: 'utf8', timeout: 5000 });
const config = configuration(temp);
// Do not classify any real orphan process during this integration test.
config.shells = new Set(); config.runtimes = new Set(); config.gitstatus = path.join(temp, 'no-gitstatus');
const ps = createPs();
const tmux = createTmux(ps, fs, (command, args, env) => {
  const redirected = [...args];
  assert.deepEqual(redirected.slice(0, 2), ['-L', 'default']);
  redirected[1] = socket;
  return spawnSync(command, redirected, { env, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
});
const output = [];
const dependencies = { config, ps, tmux, write: line => output.push(line) };
const bound = setTimeout(() => {
  if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
  try { call(['kill-server']); } catch {}
}, 30_000);
let started = false;
try {
  call(['new-session', '-d', '-s', name, '-x', '80', '-y', '24', 'sleep 60']); started = true;
  const deadline = Math.floor(Date.now() / 1000) + 1;
  const registration = registerTmux({ name, pid: owner.pid, deadline }, dependencies);
  assert.ok(registration.owner.startsWith(`${owner.pid}:`));
  await delay(1500);
  const live = runReaper({ apply: true, report: true }, dependencies);
  assert.equal(live.tmux.eligible, 0);
  assert.ok(output.some(line => line.includes('live-owner')));
  assert.equal(call(['has-session', '-t', name]), '');
  console.log('PASS real expired tmux task stays intact while owner is alive');
  owner.kill('SIGTERM');
  await new Promise(resolve => owner.once('exit', resolve));
  const dead = runReaper({ apply: true, report: true }, dependencies);
  assert.equal(dead.tmux.eligible, 1); assert.equal(dead.tmux.failed, 0);
  const state = spawnSync(binary, ['-L', socket, 'has-session', '-t', name], { encoding: 'utf8', timeout: 5000 });
  assert.notEqual(state.status, 0);
  assert.ok(output.some(line => line.startsWith('Killed tmux')));
  console.log('PASS real expired private tmux task is removed after its owner exits');
  console.log('ALL PASS isolated live reaper integration');
} finally {
  clearTimeout(bound);
  if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
  if (started) { try { call(['kill-server']); } catch {} }
  fs.rmSync(temp, { recursive: true, force: true });
}
