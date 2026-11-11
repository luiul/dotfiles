#!/usr/bin/env node
/** Real Pi TUI, private HOME and package copy, no credentials or external model calls. */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { applyPatch, preparePatch } from './patch-hermes-memory.mjs';
import { RexTestDriver } from './rex-test-driver.mjs';
assert(!process.versions.bun, 'Run this live harness with native Node');
const root=mkdtempSync(join(tmpdir(),'hermes-interactive-'));
const pkg=join(root,'package'), installed=join(homedir(),'.pi/agent/npm/node_modules/pi-hermes-memory');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const deadline=Date.now()+90_000;
let driver,host,pid,failure,report,cancelled=false;
const cancel=()=>{cancelled=true};
process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
const records=()=>existsSync(join(root,'events.jsonl'))?readFileSync(join(root,'events.jsonl'),'utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];
const wait=async(fn,label)=>{const until=Math.min(deadline,Date.now()+20_000);while(Date.now()<until){assert(!cancelled,'TUI fixture cancelled');if(fn())return;await sleep(100)}throw Error(`TUI timeout: ${label}`)};
const alive=pid=>{try{process.kill(pid,0);return true}catch(error){if(error.code==='ESRCH')return false;throw error}};
try {
  // Read the managed marker, not a stale current link. Unknown fixture APIs fail closed.
  const install=join(homedir(),'.pi/agent/install');
  const version=readFileSync(join(install,'current-version'),'utf8').trim();
  assert(['1.5.0','1.5.1'].includes(version),'Unsupported Pi fixture API');
  const runtime=join(install,'releases',version,'node_modules/@earendil-works/pi-coding-agent');
  assert.equal(JSON.parse(readFileSync(join(runtime,'package.json'),'utf8')).version,version,'Managed Pi package mismatch');
  assert(existsSync(join(runtime,'dist/cli.js')),'Managed Pi CLI missing');
  // This is a read-only source-pin check. Apply the reviewed patch only to our copy.
  const source=preparePatch(installed);
  cpSync(installed,pkg,{recursive:true,filter:p=>!p.slice(installed.length).includes('/node_modules')});
  cpSync(join(installed,'node_modules'),join(pkg,'node_modules'),{recursive:true});
  const req=createRequire(join(installed,'package.json'));
  for(const dep of ['strip-ansi','ansi-regex'])cpSync(dirname(req.resolve(dep)),join(pkg,'node_modules',dep),{recursive:true});
  applyPatch(pkg,true);
  const home=join(root,'home'),agent=join(home,'.pi/agent');mkdirSync(agent,{recursive:true});
  writeFileSync(join(agent,'settings.json'),JSON.stringify({packages:[],compaction:{enabled:false},retry:{enabled:false},cacheWarming:'off',enableInstallTelemetry:false,defaultProjectTrust:'never'}));
  writeFileSync(join(agent,'hermes-memory-config.json'),JSON.stringify({memoryDir:join(root,'memory'),projectsMemoryDir:join(root,'projects-memory'),reviewEnabled:false,correctionDetection:false,flushOnShutdown:false,flushOnCompact:false,autoConsolidate:false,quickCheckOnOpen:false}));
  const fixture=join(root,'fixture.ts'),events=join(root,'events.jsonl');
  writeFileSync(fixture,`import fs from 'node:fs';import hermes from ${JSON.stringify(join(pkg,'src/index.ts'))};import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
export default async function(pi){const tools=new Map();await hermes({...pi,registerTool(t){tools.set(t.name,t);pi.registerTool(t)}});const note=(v)=>fs.appendFileSync(${JSON.stringify(events)},JSON.stringify(v)+'\\n');
pi.registerProvider('fixture',{api:'fixture-api',baseUrl:'http://local.invalid',apiKey:'fixture',models:[{id:'fixture',name:'Memory fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:512}],streamSimple(model,context){const stream=createAssistantMessageEventStream();queueMicrotask(()=>{const m={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),content:[{type:'text',text:'MEMORY_TUI_DONE'}],stopReason:'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};stream.push({type:'done',reason:'stop',message:m});stream.end()});return stream;}});
pi.on('session_start',(_,ctx)=>note({type:'ready',pid:process.pid,mode:ctx.mode}));pi.on('agent_settled',()=>note({type:'settled'}));pi.on('session_shutdown',()=>note({type:'shutdown'}));
pi.registerCommand('memory-fixture',{description:'Synthetic memory tools',handler:async(_,ctx)=>{const added=await tools.get('memory_add').execute('add',{target:'user',content:'The synthetic user prefers fixture tests.'},undefined,undefined,ctx);const result=await tools.get('memory_search').execute('search',{query:'synthetic',target:'user'},undefined,undefined,ctx);if(result.isError||!JSON.stringify(result.content).includes('fixture tests'))throw Error('Memory fixture failed');pi.sendMessage({customType:'memory-fixture',content:'MEMORY_LOOKUP_OK',display:true});note({type:'lookup'})}});
}`);
  assert(!cancelled && Date.now()<deadline,'TUI fixture cancelled or expired');
  // The private supervisor registers the actual exec target before Pi can run.
  // Pass literal argv and an allowlisted environment, never credentials or loader hooks.
  driver=await RexTestDriver.start({deadlineMs:Math.max(1000,deadline-Date.now())});
  host=driver.create({name:'ag-pi-memory-'+process.pid,cwd:root,columns:110,rows:35,
    command:[process.execPath,join(runtime,'dist/cli.js'),'--offline','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-mcp','--no-approve','--provider','fixture','--model','fixture','--thinking','off','-e',fixture],
    env:{HOME:home,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',TMPDIR:root,PI_CODING_AGENT_DIR:agent,
      XDG_CACHE_HOME:join(root,'cache'),JITI_CACHE_DIR:join(root,'jiti'),PI_OFFLINE:'1',PI_SKIP_VERSION_CHECK:'1',PI_TELEMETRY:'0'}});
  await wait(()=>records().some(x=>x.type==='ready'),'session_start');
  const ready=records().find(x=>x.type==='ready');pid=ready.pid;
  assert.equal(ready.mode,'tui','Fixture must run in the real TUI');
  assert(Number.isSafeInteger(pid)&&pid>1,'Invalid Pi fixture PID');
  assert.equal(pid,driver.pid(host),'Fixture PID must match the supervised exec target, not Rex login');
  assert(driver.process(host).child,'Pi terminal child missing');
  driver.text(host,'memory test');driver.key(host,'enter');
  await wait(()=>records().some(x=>x.type==='settled'),'agent_settled');
  await wait(()=>driver.capture(host).includes('MEMORY_TUI_DONE'),'model response frame');
  driver.text(host,'/memory-fixture');driver.key(host,'enter');
  await wait(()=>records().some(x=>x.type==='lookup'),'memory lookup');
  await wait(()=>driver.capture(host).includes('MEMORY_LOOKUP_OK'),'memory lookup frame');
  const cpu=()=>execFileSync('/bin/ps',['-p',String(pid),'-o','time='],{encoding:'utf8',timeout:5000,env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}}).trim();
  const idleStart=cpu();await sleep(2000);const idleEnd=cpu();
  driver.key(host,'ctrl+d');await wait(()=>records().some(x=>x.type==='shutdown'),'session_shutdown');
  await wait(()=>Boolean(driver.process(host).last_exit),'Pi process exit');
  assert.equal(driver.process(host).last_exit.exit_code,0,'Pi must exit normally');
  report={status:'PASS',mode:'real TUI',backend:'RexTestDriver',piVersion:version,hermesVersion:source.version,
    prompt:'MEMORY_TUI_DONE',memoryTool:'MEMORY_LOOKUP_OK',idleCpu:{before:idleStart,after:idleEnd,intervalSeconds:2},
    note:'CPU resolution only; isolated candidate, no whole-stack or old tmux timing comparison'};
} catch(error) {
  failure=error;
  if(host){try{console.error(driver.capture(host).slice(-5000))}catch{}}
} finally {
  const cleanupErrors=[];
  // Close the PTY first, then verify the private server and registered targets are gone.
  // Retain fixture evidence if shutdown is unresolved. Never touch the desktop server.
  if(host){
    try{pid??=driver.pid(host)}catch(error){cleanupErrors.push(error)}
    try{driver.close(host)}catch(error){cleanupErrors.push(error)}
  }
  let stopped=!driver;
  if(driver){try{await driver.stop();stopped=true;assert(!existsSync(driver.root),'Private Rex fixture remains')}catch(error){cleanupErrors.push(error)}}
  if(pid){try{assert(!alive(pid),`Pi fixture PID ${pid} survived cleanup`)}catch(error){cleanupErrors.push(error);stopped=false}}
  if(stopped){rmSync(root,{recursive:true,force:true});assert(!existsSync(root))}
  else console.error(`Cleanup evidence retained: ${root}`);
  process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);
  if(cleanupErrors.length)failure=new AggregateError([...(failure?[failure]:[]),...cleanupErrors],'Hermes fixture failed or cleanup is unresolved');
}
if(failure)throw failure;
console.log(JSON.stringify({...report,cleanup:'private Rex stopped; Pi target gone; private fixture removed'}));
