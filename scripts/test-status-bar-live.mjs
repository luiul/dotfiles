#!/usr/bin/env node
// A real stubborn Git child must stop at the footer's deadline.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'status-bar-live-'));
const probe = path.join(temp, 'probe.mjs');
const pidFile = path.join(temp, 'pid');
const executable = path.join(temp, 'git');
const extension = path.resolve('pi/.pi/agent/extensions/status-bar.ts');
fs.writeFileSync(executable, `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>process.exit(0),10000);`, { mode: 0o700 });
fs.writeFileSync(probe, `import extension from ${JSON.stringify(extension)};
const handlers=new Map();let renders=0;
extension({on:(name,fn)=>handlers.set(name,fn),registerCommand:()=>{},getThinkingLevel:()=>"off"});
const ctx={mode:'tui',hasUI:true,cwd:${JSON.stringify(temp)},ui:{setFooter:factory=>factory?.({requestRender:()=>renders++},{},{onBranchChange:()=>()=>{}})}};
try{await handlers.get('session_start')({},ctx);await new Promise(r=>setTimeout(r,2700));console.log(JSON.stringify({renders}));}finally{await handlers.get('session_shutdown')({},ctx);}`);
const child = spawn(process.execPath, [probe], { env: { ...process.env, PATH: temp + path.delimiter + process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let stdout = '', stderr = '';
child.stdout.on('data', b => stdout += b);
child.stderr.on('data', b => stderr += b);
const bound = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 12000);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
try {
  const [exit] = await once(child, 'close');
  assert.equal(exit, 0, stderr);
  assert.ok(fs.existsSync(pidFile), 'fixture never started');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(alive(pid), false, 'stubborn Git child survived timeout');
  assert.ok(JSON.parse(stdout).renders > 0, 'refresh promise never completed');
  console.log('PASS real footer timeout kills TERM-resistant Git and releases its refresh slot');
} finally {
  clearTimeout(bound);
  if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
  await delay(100);
  fs.rmSync(temp, { recursive: true, force: true });
}
