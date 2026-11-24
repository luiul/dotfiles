#!/usr/bin/env node
/** Bounded local regressions. Active code is read-only; all state is disposable. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareRolling, rollingName, rollingSource, legacySource, disabledNpm } from './prepare-hermes-rolling.mjs';
import { activateRolling, resolveManagedRuntime } from './activate-hermes-rolling.mjs';
import { preparePatch, applyPatch } from './patch-hermes-memory.mjs';
const repo = resolve(import.meta.dirname, '..');
const active = join(homedir(), '.pi/agent/packages/pi-hermes-memory/0.10.0-evidence-v1');
const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hermes-fixes-')));
const partsFile = join(repo, 'pi/.pi/agent/patches/hermes-memory/src/handlers/message-parts.ts');
const watchdog = join(repo, 'pi/.pi/agent/patches/hermes-memory/src/handlers/child-process-watchdog.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
async function until(f, label, ms = 7000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (f()) return; await sleep(20); }
  throw Error('Deadline: ' + label);
}
const message = (id, content, role = 'user') => ({ type:'message', id, timestamp:'2026-11-25', message:{role,content,toolName:'bash',isError:true} });
const pass = text => console.log('PASS ' + text);
let checks = 0;
try {
  const before = await import(pathToFileURL(join(active, 'src/handlers/message-parts.ts')));
  const parts = await import(pathToFileURL(partsFile));
  const hostile = message('ID_HEAD'+'\u0000'.repeat(100000)+'ID_TAIL', 'HEAD'+'\u0000'.repeat(50000)+'TAIL');
  hostile.timestamp = 'TIME_HEAD'+'\n'.repeat(100000)+'TIME_TAIL';
  assert(before.collectMessageParts([hostile])[0].length > 48000, 'Before fixture must reproduce overflow');
  for (const role of ['user', 'assistant', 'toolResult']) {
    const row = {...hostile, message:{...hostile.message,role,toolName:'TOOL_HEAD'+'\u0000'.repeat(100000)+'TOOL_TAIL'}};
    const part = parts.collectMessageParts([row])[0];
    assert(part.length <= 48000); assert(part.includes('HEAD')); assert(part.includes('TAIL')); assert(part.includes('TRUNCATED'));
    const match = part.match(/^\[(USER|ASSISTANT|TOOL_RESULT)\] source=(.*) content=(.*)$/);
    assert(match); const source = JSON.parse(match[2]), content = JSON.parse(match[3]);
    assert(source.entryId.startsWith('ID_HEAD') && source.entryId.endsWith('ID_TAIL'));
    assert(source.timestamp.startsWith('TIME_HEAD') && source.timestamp.endsWith('TIME_TAIL'));
    assert(content.startsWith('HEAD') && content.endsWith('TAIL'));
    if (role === 'toolResult') { assert(source.tool.startsWith('TOOL_HEAD')); assert(source.tool.endsWith('TOOL_TAIL')); assert.equal(source.isError,true); }
  }
  for (const text of ['\\"\n\u0000'.repeat(20000), '\ud800'.repeat(50000), 'x'.repeat(16000), '🙂'.repeat(30000)]) {
    const batch = parts.collectReviewBatch(Array.from({length:20},(_,i)=>message('e'+i,'HEAD'+text+'TAIL')));
    assert(batch.parts.join('\n\n').length <= 48000); assert(batch.parts.every(p=>p.length<=48000));
    assert.equal(batch.cursor.throughId, 'e'+(batch.parts.length-1));
  }
  const entries = Array.from({length:15},(_,i)=>message('ordered'+i,'H'+'\u0000'.repeat(20000)+'T'));
  let branch = [...entries], delivered = [];
  while (delivered.length < entries.length) {
    const batch = parts.collectReviewBatch(branch); assert(batch.parts.length > 0);
    delivered.push(...batch.parts.map(p=>JSON.parse(p.match(/source=(.*) content=/)[1]).entryId));
    branch.push({type:'custom',customType:parts.CURSOR_TYPE,data:batch.cursor});
  }
  assert.deepEqual(delivered, entries.map(e=>e.id));
  const boundary = Array.from({length:300},(_,i)=>message('b'+i,'x'.repeat(300)));
  assert(parts.collectReviewBatch(boundary).parts.join('\n\n').length <= 48000);
  assert.equal(parts.collectReviewBatch(entries,0.5).parts.length,1);
  pass('before overflow reproduced; JSON record and joined batch bounds, quoted metadata omissions, roles and oldest-first delivery'); checks++;

  const agent = join(root,'agent'); fs.mkdirSync(join(agent,'packages/pi-hermes-memory'),{recursive:true});
  fs.cpSync(active,join(agent,'packages/pi-hermes-memory/0.10.0-evidence-v1'),{recursive:true});
  const installed = join(agent,'npm/node_modules/pi-hermes-memory'); fs.mkdirSync(installed,{recursive:true}); fs.writeFileSync(join(installed,'package.json'),JSON.stringify({version:'0.11.0'}));
  assert.equal(preparePatch(active).revision,'hermes-evidence-scope-v1');
  assert.throws(()=>applyPatch(join(agent,'packages/pi-hermes-memory/0.10.0-evidence-v1'),true),/immutable/);
  assert.throws(()=>prepareRolling(agent),/approval/);
  const candidate = prepareRolling(agent,undefined,true);
  assert.equal(candidate,join(agent,'packages/pi-hermes-memory',rollingName));
  assert.equal(prepareRolling(agent),candidate, 'Existing destination checked before rejecting upgraded npm');
  assert.equal(preparePatch(candidate).revision,'hermes-evidence-scope-v2');
  assert.throws(()=>applyPatch(candidate,true),/immutable/);
  const file=join(candidate,'src/handlers/message-parts.ts'), bytes=fs.readFileSync(file); fs.appendFileSync(file,'\n// drift');
  assert.throws(()=>prepareRolling(agent),/drift/);fs.writeFileSync(file,bytes);
  const central=join(root,'central.json');fs.writeFileSync(central,JSON.stringify({packages:[disabledNpm,{source:legacySource,extensions:[]}]}));
  fs.writeFileSync(join(agent,'settings.json'),JSON.stringify({packages:[disabledNpm,legacySource,'npm:unrelated'],theme:'dark',model:'unchanged'}));
  await assert.rejects(activateRolling(agent,resolveManagedRuntime(),false,central),/approval/);
  await assert.rejects(activateRolling(agent,resolveManagedRuntime(),true,central),/Central intake/);
  fs.writeFileSync(central,JSON.stringify({packages:[disabledNpm,{source:legacySource,extensions:[]},{source:rollingSource,extensions:[]}]}));
  const {SettingsManager}=await import(pathToFileURL(join(resolveManagedRuntime(),'dist/core/settings-manager.js')));
  const stale=SettingsManager.create(root,agent);
  await activateRolling(agent,resolveManagedRuntime(),true,central);
  stale.setTheme('light');await stale.flush();
  const settings=JSON.parse(fs.readFileSync(join(agent,'settings.json')));
  assert.deepEqual(settings,{packages:[disabledNpm,rollingSource,'npm:unrelated'],theme:'light',model:'unchanged'});
  const saved=fs.readFileSync(join(agent,'settings.json'));await activateRolling(agent,resolveManagedRuntime(),true,central);assert.deepEqual(fs.readFileSync(join(agent,'settings.json')),saved);
  for (const invalid of [[{...disabledNpm,extensions:['custom']},legacySource], [disabledNpm,{source:legacySource,extensions:['custom']}], [disabledNpm,legacySource,rollingSource], [disabledNpm,join(agent,'packages/pi-hermes-memory/0.10.0-evidence-v1')]]) {
    const invalidSettings=JSON.stringify({packages:invalid,theme:'preserved'});fs.writeFileSync(join(agent,'settings.json'),invalidSettings);
    await assert.rejects(activateRolling(agent,resolveManagedRuntime(),true,central),/Refuse|Multiple/);
    assert.equal(fs.readFileSync(join(agent,'settings.json'),'utf8'),invalidSettings);
  }
  fs.writeFileSync(join(agent,'settings.json'),saved);
  pass('immutable v2 from active v1, legacy checks, newer npm idempotence, drift, approval, central exclusion and locked stale-session settings');checks++;

  const leaf=join(root,'leaf.mjs'),middle=join(root,'middle.mjs'),work=join(root,'work.mjs');
  fs.writeFileSync(leaf,`import fs from 'node:fs';process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv[2]+'/leaf',String(process.pid));const t=setInterval(()=>{if(fs.existsSync(process.argv[2]+'/release')){clearInterval(t);process.exit(0)}},20);setTimeout(()=>process.exit(0),12000);`);
  fs.writeFileSync(middle,`import {spawn} from 'node:child_process';import fs from 'node:fs';fs.writeFileSync(process.argv[2]+'/middle',String(process.pid));spawn(process.execPath,[${JSON.stringify(leaf)},process.argv[2]],{stdio:process.argv[3]==='pipes'?'inherit':'ignore'});const t=setInterval(()=>{if(fs.existsSync(process.argv[2]+'/leaf'))process.exit(0)},20);setTimeout(()=>process.exit(1),5000);`);
  fs.writeFileSync(work,`import {spawn} from 'node:child_process';import fs from 'node:fs';fs.writeFileSync(process.argv[2]+'/root',String(process.pid));const p=spawn(process.execPath,[${JSON.stringify(middle)},process.argv[2],process.argv[3]],{stdio:'inherit'});process.on('SIGTERM',()=>process.exit(0));if(process.argv[4]==='exit'){const t=setInterval(()=>{if(fs.existsSync(process.argv[2]+'/leaf'))process.exit(0)},20)}setTimeout(()=>process.exit(0),10000);`);
  async function lifecycle(label, mode, action, old=false) {
    const dir=join(root,label);fs.mkdirSync(dir);const cancel=join(dir,'cancel');
    let owner, sockets=[], ownerFile='-', proc, stderr='';
    if(action==='parent'){ownerFile=join(dir,'owner.sock');owner=createServer(s=>sockets.push(s));await new Promise(r=>owner.listen(ownerFile,r));}
    const path=old?join(active,'src/handlers/child-process-watchdog.mjs'):watchdog;
    const args=[path,action==='timeout'?'2200':'8000',cancel,...(old?[]:[ownerFile]),process.execPath,work,dir,mode,action==='root'?'exit':'stay'];
    proc=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe']});proc.stdout.resume();proc.stderr.on('data',b=>stderr+=b);
    const completion=once(proc,'close');
    const bound=setTimeout(()=>{if(proc.exitCode===null&&proc.signalCode===null)proc.kill('SIGKILL');},11000);
    try {
      await until(()=>fs.existsSync(join(dir,'leaf')),label+' leaf readiness');
      const pids=['root','middle','leaf'].map(f=>Number(fs.readFileSync(join(dir,f))));assert(pids.every(p=>p>1));assert(alive(pids[2]));
      const cleanupStart=Date.now();
      if(action==='cancel')fs.writeFileSync(cancel,'');
      if(action==='signal')proc.kill('SIGTERM');
      if(action==='death')proc.kill('SIGKILL');
      if(action==='parent'){assert(sockets.length>0);for(const s of sockets)s.destroy();await new Promise(r=>owner.close(r));owner=null;}
      const [code,signal]=await completion;
      if(!old&&['cancel','signal','parent'].includes(action))assert(Date.now()-cleanupStart>=450,'Cancellation must retain TERM/KILL grace');
      if(old){assert(alive(pids[2]),'Before root-exit fixture must reproduce surviving descendant');fs.writeFileSync(join(dir,'release'),'');}
      await until(()=>pids.every(p=>!alive(p)),label+' descendants gone');
      if(action==='timeout')assert.equal(code,124,stderr);
      if(['cancel','signal','parent'].includes(action))assert.equal(code,143,stderr);
      if(action==='root')assert.equal(code,0,stderr);
      if(action==='death')assert.equal(signal,'SIGKILL');
      pass(label+' all fixture descendants gone');checks++;
    } finally {
      clearTimeout(bound);fs.writeFileSync(join(dir,'release'),'');
      for(const s of sockets)s.destroy();if(owner)await new Promise(r=>owner.close(r));
      if(proc.exitCode===null&&proc.signalCode===null){proc.kill('SIGKILL');await completion;}
      // Fixture release and deadlines own cleanup, never a remembered process group.
      for(const name of ['root','middle','leaf'])if(fs.existsSync(join(dir,name)))await until(()=>!alive(Number(fs.readFileSync(join(dir,name)))),label+' final cleanup',13000);
    }
  }
  await lifecycle('before-root-redirected','redirect','root',true);
  for(const mode of ['pipes','redirect'])for(const action of ['root','timeout','cancel','signal','death','parent'])await lifecycle(action+'-'+mode,mode,action);
  for(const [label,script,expected] of [
    ['success','console.log("OK");console.error("ERR");',0],
    ['nonzero','process.exit(7)',7],
    ['stdin-eof','process.stdin.on("end",()=>process.exit(0));process.stdin.resume()',0],
    ['signal-reset','process.on("SIGINT",()=>process.exit(12));setInterval(()=>{},1000);process.kill(process.pid,"SIGINT")',12],
  ]) {
    const p=spawn(process.execPath,[watchdog,'5000','-','-',process.execPath,'-e',script],{stdio:['ignore','pipe','pipe']});let out='';p.stdout.on('data',b=>out+=b);p.stderr.resume();const timer=setTimeout(()=>p.kill('SIGKILL'),7000);
    try {const [code]=await once(p,'close');assert.equal(code,expected,label);if(label==='success')assert.equal(out,'OK\n');}finally{clearTimeout(timer);}
    pass(label);checks++;
  }
  for (const exitCode of [0,7]) {
    const doneFile=join(root,'completed-'+exitCode);
    const script=`import fs from 'node:fs';const stdout='O'.repeat(2*1024*1024)+'OUT_TAIL';const stderr='E'.repeat(1024*1024)+'ERR_TAIL';let flushed=0;const done=()=>{if(++flushed===2){fs.writeFileSync(${JSON.stringify(doneFile)},String(Date.now()));process.exit(${exitCode});}};process.stdout.write(stdout,done);process.stderr.write(stderr,done);`;
    const p=spawn(process.execPath,[watchdog,'10000','-','-',process.execPath,'--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});
    const completion=once(p,'close'), timer=setTimeout(()=>{if(p.exitCode===null&&p.signalCode===null)p.kill('SIGKILL');},12000);
    let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);
    try {
      const [code]=await completion;assert.equal(code,exitCode);
      assert.equal(stdout,'O'.repeat(2*1024*1024)+'OUT_TAIL');assert.equal(stderr,'E'.repeat(1024*1024)+'ERR_TAIL');
      const cleanupMs=Date.now()-Number(fs.readFileSync(doneFile));
      assert(cleanupMs<400,`Normal status must not wait for 500ms escalation: ${cleanupMs}ms`);
      pass(`normal status ${exitCode}: full buffered output, cleanup ${cleanupMs}ms`);checks++;
    }finally{clearTimeout(timer);if(p.exitCode===null&&p.signalCode===null){p.kill('SIGKILL');await completion;}}
  }
  const parentFixture=join(root,'parent.mjs');
  fs.writeFileSync(parentFixture,`import fs from 'node:fs';import {createServer} from 'node:net';import {spawn} from 'node:child_process';const dir=process.argv[2];const sockets=[];const server=createServer(s=>sockets.push(s));server.listen(dir+'/host.sock',()=>{const child=spawn(process.execPath,[${JSON.stringify(watchdog)},'10000','-',dir+'/host.sock',process.execPath,${JSON.stringify(work)},dir,'redirect','stay'],{stdio:'ignore'});fs.writeFileSync(dir+'/watchdog',String(child.pid));});setTimeout(()=>process.exit(0),12000);`);
  const deathDir=join(root,'real-parent-death');fs.mkdirSync(deathDir);
  const parent=spawn(process.execPath,[parentFixture,deathDir],{stdio:'ignore'}),parentClosed=once(parent,'close');
  const parentBound=setTimeout(()=>{if(parent.exitCode===null&&parent.signalCode===null)parent.kill('SIGKILL');},14000);
  try {
    await until(()=>fs.existsSync(join(deathDir,'leaf')),'real parent death readiness');
    const pids=['watchdog','root','middle','leaf'].map(f=>Number(fs.readFileSync(join(deathDir,f))));assert(pids.every(p=>p>1));assert(alive(pids[0])&&alive(pids[3]));
    parent.kill('SIGKILL');await parentClosed;
    await until(()=>pids.every(p=>!alive(p)),'host death cleanup');
    pass('actual host SIGKILL closes socket; watchdog and turnover descendants gone');checks++;
  }finally {
    clearTimeout(parentBound);fs.writeFileSync(join(deathDir,'release'),'');
    if(parent.exitCode===null&&parent.signalCode===null){parent.kill('SIGKILL');await parentClosed;}
    for(const name of ['watchdog','root','middle','leaf'])if(fs.existsSync(join(deathDir,name)))await until(()=>!alive(Number(fs.readFileSync(join(deathDir,name)))),'host death final cleanup',14000);
  }
  // The public repair command must be read-only by default, with retained backups on approved writes.
  const db=join(root,'sessions.db');execFileSync('sqlite3',[db,'CREATE TABLE memories(id INTEGER); INSERT INTO memories VALUES(1);']);
  const artifact=db+'.corrupt-keep';fs.writeFileSync(artifact,'recovery');const dbBefore=fs.readFileSync(db);
  const repair=join(repo,'pi/bin/pi-memory-repair.sh');
  execFileSync('bash',[repair,'--db',db],{timeout:10000});assert.deepEqual(fs.readFileSync(db),dbBefore);assert(fs.existsSync(artifact));
  assert.throws(()=>execFileSync('bash',[repair,'--db',db,'--checkpoint'],{timeout:10000,stdio:'pipe'}));
  const backup=join(root,"retained's backup");execFileSync('bash',[repair,'--db',db,'--checkpoint','--approved','--backup-dir',backup],{timeout:10000});assert(fs.existsSync(join(backup,'sessions.db')));assert(fs.existsSync(artifact));
  assert.throws(()=>execFileSync('bash',[repair,'--db',db,'--checkpoint','--approved','--backup-dir',backup],{timeout:10000,stdio:'pipe'}));
  const corrupt=join(root,'corrupt.db');fs.writeFileSync(corrupt,'not a database');const corruptBefore=fs.readFileSync(corrupt);
  assert.throws(()=>execFileSync('bash',[repair,'--db',corrupt,'--checkpoint','--approved','--backup-dir',join(root,'corrupt-backup')],{timeout:10000,stdio:'pipe'}));
  assert.deepEqual(fs.readFileSync(corrupt),corruptBefore);assert(!fs.existsSync(join(root,'corrupt-backup')));
  pass('repair health leaves bytes and artifacts unchanged; approval and retained backup for checkpoint');checks++;
  console.log('Checks: '+checks+' passed. Private fixtures only.');
} finally {fs.rmSync(root,{recursive:true,force:true});assert(!fs.existsSync(root));}
