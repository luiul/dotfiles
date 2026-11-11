#!/usr/bin/env node
/** Parent-death and deadline gates. Only explicitly created fixtures are used. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const module = fileURLToPath(new URL('./rex-test-driver.mjs', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function wait(predicate, description, milliseconds = 15_000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) { if (predicate()) return; await pause(100); }
  throw new Error(`Timed out: ${description}`);
}
async function scenario({ name, killOwner = false, deadlineMs = 20_000 }) {
  const source = `import fs from 'node:fs'; import {RexTestDriver} from ${JSON.stringify(module)};
const driver=await RexTestDriver.start({deadlineMs:${deadlineMs}});
const host=driver.create({command:['/bin/sh','-c','echo LIFECYCLE_READY; sleep 90'],columns:70,rows:20});
const end=Date.now()+15000;
while(!driver.pid(host)&&Date.now()<end)await new Promise(r=>setTimeout(r,100));
if(!driver.pid(host))throw Error('target did not start');
console.log(JSON.stringify({root:driver.root,pid:driver.pid(host),serverPid:driver.manifest().serverPid}));
setTimeout(()=>{},90000);`;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', record;
  owner.stdout.on('data', b => { stdout += b; const line = stdout.split('\n').find(s => s.startsWith('{')); if (line) record = JSON.parse(line); });
  owner.stderr.on('data', b => { stderr = (stderr + b).slice(-3000); });
  try {
    await wait(() => record || owner.exitCode !== null, `${name} startup`, 22_000);
    assert(record, stderr);
    assert(alive(record.pid), 'Target must exist before testing cleanup');
    if (killOwner) owner.kill('SIGKILL');
    await wait(() => fs.existsSync(`${record.root}/stopped`), `${name} supervisor completion`, deadlineMs + 15_000);
    const result = JSON.parse(fs.readFileSync(`${record.root}/stopped`, 'utf8'));
    assert(result.clean, JSON.stringify(result));
    assert(!alive(record.serverPid), 'Private server remains');
    assert(!alive(record.pid), 'Registered target remains');
    assert(!fs.existsSync(`${record.root}/server.sock`));
    console.log(`PASS ${name}: target and private server removed`);
  } finally {
    if (alive(owner.pid)) owner.kill('SIGKILL');
    // Never remove ownership metadata until shutdown was positively confirmed.
    if (record && fs.existsSync(`${record.root}/stopped`)) {
      const stopped = JSON.parse(fs.readFileSync(`${record.root}/stopped`, 'utf8'));
      if (stopped.clean && !alive(record.serverPid) && !alive(record.pid)) fs.rmSync(record.root, { recursive: true });
    }
  }
}
await scenario({ name: 'owner SIGKILL', killOwner: true });
await scenario({ name: 'deadline while owner alive', deadlineMs: 10_000 });

// Detached fixtures must register before they begin useful work. Neither Rex nor
// terminal hangup can contain arbitrary unregistered self-detaching processes.
const { RexTestDriver } = await import('./rex-test-driver.mjs');
const driver = await RexTestDriver.start({ deadlineMs: 30_000 });
const ack = `${driver.root}/detached.registered`;
const detached = spawn(process.execPath, ['--input-type=module', '-e', `
import fs from 'node:fs';
process.on('SIGHUP',()=>{}); process.on('SIGTERM',()=>{});
const end=Date.now()+15000;
while(!fs.existsSync(${JSON.stringify(ack)})&&Date.now()<end)await new Promise(r=>setTimeout(r,50));
if(!fs.existsSync(${JSON.stringify(ack)}))process.exit(125);
fs.writeFileSync(${JSON.stringify(`${driver.root}/detached.ready`)},'');
setTimeout(()=>{},60000);
`], { detached: true, stdio: 'ignore' });
try {
  const registered = driver.registerChild(detached.pid);
  await wait(() => fs.existsSync(registered), 'detached registration');
  fs.writeFileSync(ack, '');
  await wait(() => fs.existsSync(`${driver.root}/detached.ready`), 'detached startup');
  assert(alive(detached.pid));
  await driver.stop();
  assert(!alive(detached.pid), 'Registered detached target survived cleanup');
  console.log('PASS registered detached HUP/TERM-resistant fixture removed');
} finally {
  if (alive(detached.pid)) detached.kill('SIGKILL');
  if (fs.existsSync(driver.root)) await driver.stop();
}
console.log('ALL PASS bounded Rex lifecycle gates');
