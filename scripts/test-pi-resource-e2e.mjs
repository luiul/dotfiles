#!/usr/bin/env node
// Real Pi startup and quiet-session resource checks. No model calls.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = { extension: join(repo, 'pi/.pi/agent/extensions/status-bar.ts'), baseline: false, rpcOnly: false, seconds: 12 };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--extension' && args[i + 1]) options.extension = resolve(args[++i]);
  else if (args[i] === '--baseline') options.baseline = true;
  else if (args[i] === '--rpc-only') options.rpcOnly = true;
  else if (args[i] === '--seconds' && args[i + 1]) options.seconds = Number(args[++i]);
  else throw new Error(`Unknown argument ${args[i]}`);
}
assert.ok(Number.isFinite(options.seconds) && options.seconds >= 8 && options.seconds <= 30);
const dir = mkdtempSync(join(tmpdir(), 'pi-resource-e2e-'));
const bin = join(dir, 'bin'); mkdirSync(bin);
const log = join(dir, 'git-calls');
const git = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
const pi = execFileSync('/usr/bin/which', ['pi'], { encoding: 'utf8' }).trim();
const home = join(dir, 'home');
const agent = join(home, '.pi', 'agent');
mkdirSync(agent, { recursive: true });
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ quietStartup: true, compaction: { enabled: false }, retry: { enabled: false } }));
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
writeFileSync(join(bin, 'git'), `#!/bin/sh\nif [ "$1" = status ] && [ "$2" = --porcelain=2 ]; then printf 'footer-status\\n' >> ${quote(log)}; fi\nexec ${quote(git)} "$@"\n`, { mode: 0o700 });
// Both hosts get the same private HOME and explicit environment. Do not inherit
// credentials, loader hooks, live settings, or background extension services.
const environment = {
  HOME: home, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}`,
  USER: userInfo().username, LOGNAME: userInfo().username,
  TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'C', LC_ALL: 'C', TMPDIR: dir,
  XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local/share'),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
  PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
};
const flags = ['--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-session', '--no-approve', '--no-mcp', '--no-themes', '--no-tools', '-e', options.extension];
let child, driver, host, targetPid;
const cancellation = new AbortController();
const pause = ms => delay(ms, undefined, { signal: cancellation.signal });
async function until(predicate, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    cancellation.signal.throwIfAborted();
    if (predicate()) return;
    await pause(200);
  }
  throw new Error(`Timeout: ${label}`);
}
function assertGone(pid, label) {
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return; throw error; }
  throw new Error(`${label} PID ${pid} survived cleanup`);
}
const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length : 0;
function sample(pid) {
  const out = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'rss=,time='], { encoding: 'utf8', timeout: 2000 }).trim();
  const [rss, time] = out.split(/\s+/);
  const seconds = time.split(':').reverse().reduce((sum, value, i) => sum + Number(value) * 60 ** i, 0);
  return { rssMiB: Number(rss) / 1024, cpuSeconds: seconds };
}
async function interval(pid, name) {
  const before = sample(pid), begin = Date.now();
  await pause(options.seconds * 1000);
  const after = sample(pid), elapsed = (Date.now() - begin) / 1000;
  // These ps deltas measure only Pi, not Rex server/controller/supervisor CPU,
  // sampler overhead, child git processes, or whole-system peak memory. This is
  // a resource observation, not a timing comparison between terminal backends.
  const result = { name, host: name.endsWith('-rpc') ? 'rpc' : 'rex', pid, scope: 'Pi process only', elapsedSeconds: Number(elapsed.toFixed(2)), cpuOneCorePct: Number((100 * (after.cpuSeconds - before.cpuSeconds) / elapsed).toFixed(2)), rssMiB: Number(after.rssMiB.toFixed(1)), footerGitCalls: calls() };
  console.log(JSON.stringify(result));
  return result;
}
async function stopChild() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  await Promise.race([new Promise((r) => child.once('exit', r)), delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  await Promise.race([new Promise((r) => child.once('close', r)), delay(1000)]);
}
const bound = setTimeout(() => {
  cancellation.abort(new Error('Pi resource suite deadline expired'));
  if (child?.pid && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  // Interactive targets belong to the shared driver supervisor and registry.
  // finally requests stop; its independent deadline also covers owner death.
}, 100_000 + options.seconds * 2000);
try {
  child = spawn(pi, [...flags, '--mode', 'rpc'], { env: environment, detached: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: repo });
  let output = '', errors = '', launchError;
  child.on('error', error => { launchError = error; });
  child.stdin.on('error', error => { launchError ??= error; });
  child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-100_000); });
  child.stderr.on('data', (chunk) => { errors = (errors + chunk).slice(-5000); });
  child.stdin.write(JSON.stringify({ id: 'ready', type: 'get_state' }) + '\n');
  await until(() => {
    if (launchError) throw launchError;
    assert.ok(child.exitCode === null && child.signalCode === null, `RPC startup failed: ${errors}`);
    return output.includes('"id":"ready"');
  }, `RPC startup: ${errors}`);
  assert.ok(!/Failed to load extension|Extension error/.test(errors), errors);
  const headless = await interval(child.pid, options.baseline ? 'baseline-rpc' : 'fixed-rpc');
  if (options.baseline) assert.ok(headless.footerGitCalls >= 2, 'baseline must reproduce headless polling');
  else assert.equal(headless.footerGitCalls, 0, 'headless Pi must not poll footer git state');
  const rpcPid = child.pid;
  await stopChild(); child = undefined;
  assertGone(rpcPid, 'RPC Pi');
  if (options.rpcOnly) {
    console.log('ALL PASS real Pi RPC resource check (no Rex required)');
  } else {
    writeFileSync(log, '');
    // Lazy import keeps the RPC check independent of Rex and its registry.
    const { RexTestDriver } = await import('./rex-test-driver.mjs');
    driver = await RexTestDriver.start({ deadlineMs: 120_000 });
    host = driver.create({ name: `ag-pi-resources-${process.pid}`, command: [pi, ...flags], cwd: repo, env: environment, columns: 160, rows: 40 });
    const footerVisible = () => {
      const capture = driver.capture(host);
      assert.ok(!/Failed to load extension|Extension error/.test(capture), capture);
      return capture.includes('context') && capture.includes('branch');
    };
    await until(footerVisible, 'real TUI footer render');
    targetPid = driver.pid(host);
    assert.ok(Number.isSafeInteger(targetPid) && targetPid > 1, 'Driver must report the exec target PID, not the Rex login wrapper');
    const interactive = await interval(targetPid, options.baseline ? 'baseline-tui' : 'fixed-tui');
    assert.ok(interactive.footerGitCalls >= 2, 'interactive footer must still refresh');
    if (!options.baseline) {
      driver.text(host, '/statusbar'); driver.key(host, 'enter');
      await until(() => !footerVisible(), 'disabled enhanced footer');
      // Let an already-running Git refresh settle, then observe two poll periods.
      await pause(2500);
      const startCalls = calls();
      await pause(8500);
      assert.equal(calls(), startCalls, 'disabled footer must stop polling');
      driver.text(host, '/statusbar'); driver.key(host, 'enter');
      await until(footerVisible, 'reenabled enhanced footer');
      await pause(4500);
      assert.ok(calls() > startCalls, 'reenabled footer must resume polling');
      console.log('PASS real TUI disable and reenable');
    }
    driver.key(host, 'ctrl+d');
    await until(() => {
      const exit = driver.process(host).last_exit;
      if (!exit) return false;
      assert.equal(exit.exit_code, 0, JSON.stringify(exit));
      assertGone(targetPid, 'Interactive Pi');
      return true;
    }, 'interactive Pi exit');
    driver.close(host); host = undefined;
    await driver.stop();
    assert.ok(!existsSync(driver.root), 'Private Rex fixture survived cleanup');
    assertGone(targetPid, 'Interactive Pi');
    console.log('ALL PASS real Pi RPC and Rex TUI resource checks');
  }
} finally {
  clearTimeout(bound);
  try {
    await stopChild();
  } finally {
    // Do not remove the HOME fixture until the driver's owned processes stop.
    // Failed driver teardown retains evidence for its registry backstop.
    if (driver) {
      try { if (host) driver.close(host); }
      finally { await driver.stop(); }
      if (targetPid) assertGone(targetPid, 'Interactive Pi');
      assert.ok(!existsSync(driver.root), 'Private Rex fixture survived cleanup');
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
