#!/usr/bin/env node
// Real Pi startup and quiet-session resource checks. No model calls.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const options = { extension: resolve('pi/.pi/agent/extensions/status-bar.ts'), baseline: false, seconds: 12 };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--extension' && args[i + 1]) options.extension = resolve(args[++i]);
  else if (args[i] === '--baseline') options.baseline = true;
  else if (args[i] === '--seconds' && args[i + 1]) options.seconds = Number(args[++i]);
  else throw new Error(`Unknown argument ${args[i]}`);
}
assert.ok(Number.isFinite(options.seconds) && options.seconds >= 8 && options.seconds <= 30);
const dir = mkdtempSync(join(tmpdir(), 'pi-resource-e2e-'));
const bin = join(dir, 'bin'); mkdirSync(bin);
const log = join(dir, 'git-calls');
const git = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
const pi = execFileSync('/usr/bin/which', ['pi'], { encoding: 'utf8' }).trim();
const tmux = execFileSync('/usr/bin/which', ['tmux'], { encoding: 'utf8' }).trim();
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
writeFileSync(join(bin, 'git'), `#!/bin/sh\nif [ "$1" = status ] && [ "$2" = --porcelain=2 ]; then printf 'footer-status\\n' >> ${quote(log)}; fi\nexec ${quote(git)} "$@"\n`, { mode: 0o700 });
const environment = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_OFFLINE: '1' };
const flags = ['--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-session', '--no-approve', '-e', options.extension];
let child;
let tmuxStarted = false;
const socket = `ag-pi-resources-${process.pid}`;
const session = `ag-pi-resources-${process.pid}`;
const tm = (...args) => execFileSync(tmux, ['-L', socket, ...args], { encoding: 'utf8', timeout: 5000, env: environment });
const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length : 0;
function sample(pid) {
  const out = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'rss=,time='], { encoding: 'utf8', timeout: 2000 }).trim();
  const [rss, time] = out.split(/\s+/);
  const seconds = time.split(':').reverse().reduce((sum, value, i) => sum + Number(value) * 60 ** i, 0);
  return { rssMiB: Number(rss) / 1024, cpuSeconds: seconds };
}
async function interval(pid, name) {
  const before = sample(pid), begin = Date.now();
  await delay(options.seconds * 1000);
  const after = sample(pid), elapsed = (Date.now() - begin) / 1000;
  const result = { name, elapsedSeconds: Number(elapsed.toFixed(2)), cpuOneCorePct: Number((100 * (after.cpuSeconds - before.cpuSeconds) / elapsed).toFixed(2)), rssMiB: Number(after.rssMiB.toFixed(1)), footerGitCalls: calls() };
  console.log(JSON.stringify(result));
  return result;
}
async function stopChild() {
  if (!child || child.exitCode !== null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  await Promise.race([new Promise((r) => child.once('exit', r)), delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  await Promise.race([new Promise((r) => child.once('close', r)), delay(1000)]);
}
const bound = setTimeout(() => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  if (tmuxStarted) { try { tm('kill-server'); } catch {} }
}, 100_000);
try {
  child = spawn(pi, [...flags, '--mode', 'rpc'], { env: environment, detached: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: process.cwd() });
  let output = '', errors = '';
  child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-100_000); });
  child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-5000); });
  child.stdin.write(JSON.stringify({ id: 'ready', type: 'get_state' }) + '\n');
  const deadline = Date.now() + 20_000;
  while (!output.includes('"id":"ready"') && Date.now() < deadline && child.exitCode === null) await delay(100);
  assert.ok(output.includes('"id":"ready"'), `RPC startup failed: ${errors}`);
  const headless = await interval(child.pid, options.baseline ? 'baseline-rpc' : 'fixed-rpc');
  if (options.baseline) assert.ok(headless.footerGitCalls >= 2, 'baseline must reproduce headless polling');
  else assert.equal(headless.footerGitCalls, 0, 'headless Pi must not poll footer git state');
  await stopChild(); child = undefined;
  writeFileSync(log, '');

  const command = `exec env PATH=${quote(environment.PATH)} PI_OFFLINE=1 ${quote(pi)} ${flags.map(quote).join(' ')}`;
  tm('new-session', '-d', '-s', session, '-x', '160', '-y', '40', command); tmuxStarted = true;
  const tuiDeadline = Date.now() + 20_000;
  let capture = '';
  while (Date.now() < tuiDeadline) {
    capture = tm('capture-pane', '-p', '-t', session);
    if (capture.includes('context') && capture.includes('branch')) break;
    await delay(200);
  }
  assert.ok(capture.includes('context') && capture.includes('branch'), 'real TUI footer did not render');
  const panePid = Number(tm('display-message', '-p', '-t', session, '#{pane_pid}').trim());
  const interactive = await interval(panePid, options.baseline ? 'baseline-tui' : 'fixed-tui');
  assert.ok(interactive.footerGitCalls >= 2, 'interactive footer must still refresh');
  if (!options.baseline) {
    tm('send-keys', '-t', session, '-l', '/statusbar'); tm('send-keys', '-t', session, 'Enter');
    await delay(2500);
    const startCalls = calls();
    await delay(8500);
    assert.equal(calls(), startCalls, 'disabled footer must stop polling');
    tm('send-keys', '-t', session, '-l', '/statusbar'); tm('send-keys', '-t', session, 'Enter');
    await delay(4500);
    assert.ok(calls() > startCalls, 'reenabled footer must resume polling');
    console.log('PASS real TUI disable and reenable');
  }
  tm('send-keys', '-t', session, 'C-d');
  await delay(1000);
  try { tm('kill-server'); } catch {}
  tmuxStarted = false;
  try { tm('has-session', '-t', session); throw new Error('Test tmux session survived cleanup'); }
  catch (error) { if (error.message === 'Test tmux session survived cleanup') throw error; }
  try { process.kill(panePid, 0); throw new Error('Test Pi process survived cleanup'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  console.log('ALL PASS real Pi RPC and TUI resource checks');
} finally {
  clearTimeout(bound);
  await stopChild();
  if (tmuxStarted) { try { tm('kill-server'); } catch {} }
  rmSync(dir, { recursive: true, force: true });
}
