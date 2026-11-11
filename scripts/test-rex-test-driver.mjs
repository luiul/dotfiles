#!/usr/bin/env node
/** Feasibility gates. No GUI actions, real credentials, model calls, or tmux. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RexTestDriver } from './rex-test-driver.mjs';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const baseline = JSON.parse(execFileSync('rex', ['--autostart=false', 'whoami', '--json'], { encoding: 'utf8', timeout: 5000 }));
const baselineSessions = execFileSync('rex', ['--autostart=false', 'ls', '--json'], { encoding: 'utf8', timeout: 5000 });
const driver = await RexTestDriver.start({ deadlineMs: 120_000 });
const pids = new Set();
async function wait(host, pattern) {
  const until = Date.now() + 12_000;
  let screen = '';
  while (Date.now() < until) {
    screen = driver.capture(host, { history: true });
    const pid = driver.pid(host); if (pid) pids.add(pid);
    if (pattern.test(screen)) return screen;
    await pause(100);
  }
  throw new Error(`Missing ${pattern}: ${screen}`);
}
try {
  const host = driver.create({ columns: 91, rows: 31, command: ['/bin/sh', '-c', 'stty size; echo FIRST_READY; read answer; echo "ANSWER:$answer"; sleep 60'] });
  await wait(host, /31 91\nFIRST_READY/);
  const identity = driver.manifest();
  assert.notEqual(identity.instanceId, baseline.instance_id);
  assert.equal(fs.statSync(`${driver.root}/server.sock`).mode & 0o777, 0o600);
  driver.text(host, 'literal input'); driver.key(host, 'enter');
  await wait(host, /ANSWER:literal input/);
  const resized = driver.resize(host, 77, 23); assert.equal(resized.columns, 77); assert.equal(resized.rows, 23);
  console.log('PASS isolated socket, initial dimensions, literal input, named key, and resize');
  driver.close(host);

  const alt = driver.create({ columns: 80, rows: 24, command: ['/bin/sh', '-c', 'printf "PRIMARY_ONLY\\n\\033[?1049h\\033[2J\\033[H\\033[1;31mALTERNATE_RED\\033[0m\\n"; read answer; printf "\\033[?1049lEXIT:%s\\n" "$answer"; exit 7'] });
  const alternate = await wait(alt, /ALTERNATE_RED/);
  assert(!alternate.includes('PRIMARY_ONLY'), 'Capture must show the active alternate screen');
  const vt = driver.capture(alt, { format: 'vt' });
  assert(vt.includes('ALTERNATE_RED')); assert(/\x1b\[[0-9;]*m/.test(vt));
  const html = driver.capture(alt, { format: 'html' });
  assert(/ALTERNATE_RED/.test(html), 'Styled capture lost the content');
  assert(/color|font-weight/.test(html), 'Styled capture lost the attributes');
  driver.text(alt, 'done'); driver.key(alt, 'enter');
  await wait(alt, /EXIT:done/);
  for (let n = 0; n < 50 && !driver.process(alt).last_exit; n++) await pause(100);
  assert.equal(driver.process(alt).last_exit.exit_code, 7);
  console.log('PASS alternate screen, styled VT, retained output, and nonzero exit');
  driver.close(alt);

  const eventFile = `${driver.root}/protocol.jsonl`;
  const fixture = fileURLToPath(new URL('./fixtures/terminal-backend-proof.mjs', import.meta.url));
  const protocol = driver.create({ columns: 96, rows: 30, command: [process.execPath, fixture, eventFile] });
  const frame = await wait(protocol, /GRID:96x30/);
  const currentFrame = driver.capture(protocol);
  assert(currentFrame.includes('GRID:96x30') && currentFrame.includes('READY'), 'Viewport capture lost visible rows');
  assert(currentFrame.includes('café 界 🙂'));
  assert(frame.includes('café 界 🙂'));
  assert(!frame.includes('PRIMARY_BEFORE_ALT'));
  driver.resize(protocol, 41, 19);
  await wait(protocol, /GRID:41x19/);
  driver.key(protocol, 'ctrl+a');
  driver.key(protocol, 'shift+enter');
  driver.text(protocol, '\x1b[<0;4;5M');
  driver.text(protocol, 'q');
  await wait(protocol, /AFTER_ALT/);
  const records = fs.readFileSync(eventFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert(records.some(e => e.type === 'resize' && e.columns === 41 && e.rows === 19));
  assert(records.some(e => e.type === 'input' && e.hex.includes('01')), 'Ctrl+A missing');
  assert(records.some(e => e.type === 'input' && e.hex.includes('1b5b3c303b343b354d')), 'Mouse bytes missing');
  assert.equal(records.find(e => e.type === 'ready').secretsPresent, false);
  console.log('PASS Unicode, child-observed SIGWINCH, control key, mouse bytes, and credential isolation');
  driver.close(protocol);

  const historyHost = driver.create({ columns: 80, rows: 12, command: ['/bin/sh', '-c', 'i=0; while [ "$i" -lt 40 ]; do echo "OLD_HISTORY_$i"; i=$((i+1)); done; printf "\\033[2J\\033[HVISIBLE_NOW\\n"; sleep 30'] });
  await wait(historyHost, /VISIBLE_NOW/);
  const visible = driver.capture(historyHost, { trim: true });
  assert(visible.includes('VISIBLE_NOW'), 'Current viewport lost visible content');
  assert(!visible.includes('OLD_HISTORY'), 'Current viewport includes stale scrollback');
  assert(driver.capture(historyHost, { history: true }).includes('OLD_HISTORY'), 'History capture lost scrollback');
  console.log('PASS current viewport excludes scrollback while history capture retains it');
  driver.close(historyHost);
  assert.equal(execFileSync('rex', ['--autostart=false', 'ls', '--json'], { encoding: 'utf8', timeout: 5000 }), baselineSessions);
  const current = JSON.parse(execFileSync('rex', ['--autostart=false', 'whoami', '--json'], { encoding: 'utf8', timeout: 5000 }));
  assert.equal(current.instance_id, baseline.instance_id);
  assert.equal(current.session_id, baseline.session_id);
  assert.equal(current.block_id, baseline.block_id);
  console.log('PASS normal server identity and session list preserved');
} finally {
  await driver.stop();
  for (const pid of pids) {
    let alive = true;
    for (let n = 0; n < 30 && alive; n++) { try { process.kill(pid, 0); await pause(100); } catch { alive = false; } }
    assert(!alive, `Fixture target PID ${pid} survived cleanup`);
  }
  assert(!fs.existsSync(driver.root));
}
console.log('ALL PASS basic Rex feasibility gates');
