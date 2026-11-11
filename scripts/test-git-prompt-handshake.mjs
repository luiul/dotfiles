#!/usr/bin/env node
/** Test startup records in real shells without loading the daily login files. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { RexTestDriver } from './rex-test-driver.mjs';
const repo = path.resolve(import.meta.dirname, '..');
const prompt = process.env.HANDSHAKE_PROMPT ?? path.join(repo, 'zsh/.zsh_config/prompt.zsh');
const root = fs.mkdtempSync('/tmp/prompt-handshake-');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let driver;
let sequence = 0;
try {
  const binary = path.join(os.homedir(), '.cache/gitstatus/gitstatusd-darwin-arm64');
  const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 }).stdout.trim();
  assert(/^v\d+\.\d+\.\d+$/.test(version));
  const realDaemon = path.join(root, 'real-daemon');
  // GITSTATUS_DAEMON uses build.info, unlike the installed cache selection.
  // Pass the verified binary's own version so a source/cache mismatch does not
  // turn a delayed startup test into an unrelated version rejection.
  fs.writeFileSync(realDaemon, `#!/bin/sh\nsleep 2\n[ "$1" = -G ] && shift 2\nexec '${binary}' -G '${version}' "$@"\n`, { mode: 0o700 });
  const fake = path.join(root, 'fake.mjs');
  fs.writeFileSync(fake, `import fs from 'node:fs';
fs.writeFileSync(process.env.TEST_PID, String(process.pid));
process.stdin.once('data', input => {
  if (input.toString() !== '}hello\\x1f\\x1e') process.exit(8);
  const kind = process.env.TEST_KIND;
  if (kind === 'partial') {
    process.stdout.write('\\x01');
    setTimeout(() => process.stdout.write('}hel'), 150);
    setTimeout(() => process.stdout.write('lo\\x1f0\\x1e'), 450);
  } else if (kind === 'bad') process.stdout.write('}hello\\x1f9\\x1e');
  else if (kind === 'eof') process.exit(0);
});
setTimeout(() => process.exit(9), 20000);
`);
  const fakeDaemon = path.join(root, 'fake-daemon');
  fs.writeFileSync(fakeDaemon, `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`, { mode: 0o700 });
  driver = await RexTestDriver.start({ deadlineMs: 180000 });
  async function command(h, code) {
    const marker = `PROBE_${++sequence}`;
    driver.text(h, `${code}; print -r -- ${marker}`); driver.key(h, 'enter');
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      const output = driver.capture(h, { history: true });
      if (output.split('\n').includes(marker)) return output;
      await sleep(30);
    }
    throw Error('Command did not complete in its bound');
  }
  for (const kind of ['real', 'partial', 'bad', 'eof', 'stall', 'shutdown']) {
    const pidFile = path.join(root, `${kind}.pid`);
    const setup = path.join(root, `${kind}.zsh`);
    fs.writeFileSync(setup, `source '${prompt}'
_my_prompt_gitstatus_start
`);
    const h = driver.create({ command: ['/bin/zsh', '-f'], cwd: root, columns: 140, rows: 35,
      env: { HOME: os.homedir(), PATH: '/opt/homebrew/bin:/usr/bin:/bin', TMPDIR: root,
        GITSTATUS_DAEMON: kind === 'real' ? realDaemon : fakeDaemon, TEST_PID: pidFile, TEST_KIND: kind } });
    const shellEnd = Date.now() + 10000;
    while (!driver.capture(h).trimEnd().endsWith('%')) {
      assert(Date.now() < shellEnd, 'New shell must show its initial prompt before input');
      await sleep(50);
    }
    await command(h, `source '${setup}'`);
    const startup = Date.now();
    if (kind === 'real') {
      const start = Date.now();
      const output = await command(h, 'print -r -- INPUT_READY; print -r -- "WAITING=$_my_prompt_gitstatus_ok FD=$_my_prompt_daemon_start_fd"');
      assert(output.split('\n').includes('INPUT_READY'));
      assert(output.split('\n').some(l => /^WAITING=0 FD=\d+$/.test(l)), 'Input check must run before the delayed handshake completes');
      assert(Date.now() - start < 1000, 'Delayed binary startup must not hold keyboard input');
    }
    const success = kind === 'real' || kind === 'partial';
    if (kind === 'shutdown') {
      await command(h, '_my_prompt_shutdown');
    } else {
      const end = Date.now() + 11000;
      while (Date.now() < end) {
        await sleep(300);
        const output = await command(h, 'print -r -- "STATE=$_my_prompt_gitstatus_ok START_FD=$_my_prompt_daemon_start_fd TIMERS=${#zsh_scheduled_events}"');
        if (output.split('\n').includes(`STATE=${success ? 1 : 0} START_FD=-1 TIMERS=0`)) break;
      }
    }
    const result = await command(h, 'print -r -- "FINAL=$_my_prompt_gitstatus_ok START_FD=$_my_prompt_daemon_start_fd TIMERS=${#zsh_scheduled_events} REQ=${_GITSTATUS_REQ_FD_MYPROMPT:--1} RESP=${_GITSTATUS_RESP_FD_MYPROMPT:--1}"');
    assert(result.split('\n').some(l => l.startsWith(`FINAL=${success ? 1 : 0} START_FD=-1 TIMERS=0`)), kind + ': ' + result.slice(-1500));
    if (!success) assert(result.split('\n').includes('FINAL=0 START_FD=-1 TIMERS=0 REQ=-1 RESP=-1'), kind);
    if (kind === 'stall') assert(Date.now() - startup >= 3500, 'Silent daemon must stay pending until the startup deadline');
    driver.close(h);
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      const end = Date.now() + 3000;
      let alive = true;
      while (alive && Date.now() < end) {
        try { process.kill(pid, 0); } catch { alive = false; }
        if (alive) await sleep(50);
      }
      assert(!alive, 'Test daemon must exit after shell cleanup');
    }
    console.log(`PASS ${kind}: startup, descriptors, timers and child cleanup`);
  }
} finally {
  await driver?.stop();
  fs.rmSync(root, { recursive: true, force: true });
}
