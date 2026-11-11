#!/usr/bin/env node
/** Kill the owning controllers, then prove the explicit registry backstop. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { audit } from '../macos/.local/bin/reap-rex-tests.mjs';
const driverModule = fileURLToPath(new URL('./rex-test-driver.mjs', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const owner = spawn(process.execPath, ['--input-type=module', '-e', `
import fs from 'node:fs'; import {RexTestDriver} from ${JSON.stringify(driverModule)};
const d=await RexTestDriver.start({deadlineMs:15000});
const h=d.create({command:[process.execPath,'-e','process.on("SIGHUP",()=>{});process.on("SIGTERM",()=>{});console.log("RESISTANT_READY");setTimeout(()=>{},120000)']});
const end=Date.now()+12000;
while(!d.capture(h,{history:true}).includes('RESISTANT_READY')&&Date.now()<end)await new Promise(r=>setTimeout(r,100));
if(Date.now()>=end)throw Error('resistant target not ready');
console.log(JSON.stringify({root:d.root,pid:d.pid(h),...d.manifest()}));setTimeout(()=>{},120000);
`], { stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', errors = '', record;
owner.stdout.on('data', b => { output += b; const line = output.split('\n').find(l => l.startsWith('{')); if (line) record = JSON.parse(line); });
owner.stderr.on('data', b => { errors = (errors + b).slice(-3000); });
try {
  const readyEnd = Date.now() + 30_000;
  while (!record && owner.exitCode === null && Date.now() < readyEnd) await pause(100);
  assert(record, errors);
  assert(alive(record.pid), 'Resistant target must exist before failure injection');
  // The expired task must stay intact while its owner is alive. The supervisor
  // is killed first to exercise the registry rather than normal teardown.
  process.kill(record.supervisorPid, 'SIGKILL');
  while (Date.now() < record.deadline + 100) await pause(100);
  const live = audit({ apply: true });
  const held = live.tasks.find(t => t.root === record.root || t.id === `${record.registration.id}.json`);
  assert(held && held.status === 'skipped' && /owner is alive/.test(held.reason), JSON.stringify(live));
  assert(alive(record.pid) && alive(record.serverPid) && alive(record.controllerPid));
  console.log('PASS expired registered Rex task stays intact while owner is alive');
  owner.kill('SIGKILL');
  const deadline = Date.now() + 45_000;
  let report;
  while (Date.now() < deadline) {
    report = audit({ apply: true });
    if (!alive(record.pid) && !alive(record.serverPid) && !alive(record.controllerPid)) break;
    await pause(1000);
  }
  assert(!alive(record.pid), JSON.stringify(report));
  assert(!alive(record.serverPid));
  assert(!alive(record.controllerPid));
  assert(!fs.existsSync(`${record.root}/server.sock`));
  console.log('PASS dead supervisor and owner: registry removes resistant target, server and controller');
  let completed = false;
  for (let n = 0; n < 15; n++) {
    const final = audit({ apply: true });
    const task = final.tasks.find(t => t.root === record.root || t.id === `${record.registration.id}.json`);
    if (task?.status === 'completed' || !fs.existsSync(record.registration.file)) { completed = true; break; }
    await pause(200);
  }
  assert(completed, 'Registry completion must precede fixture root removal');
} finally {
  if (alive(owner.pid)) owner.kill('SIGKILL');
  // This is an explicit test-owned fallback, not the production reaper path.
  if (record) {
    for (const pid of [record.pid, record.serverPid, record.controllerPid, record.supervisorPid]) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    for (let n = 0; n < 30 && [record.pid, record.serverPid, record.controllerPid].some(alive); n++) await pause(100);
    if (![record.pid, record.serverPid, record.controllerPid].some(alive)) fs.rmSync(record.root, { recursive: true });
  }
}
