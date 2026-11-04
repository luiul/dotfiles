#!/usr/bin/env node
/** Real Pi TUI, private HOME and package copy, no credentials or external model calls. */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { applyPatch } from './patch-hermes-memory.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const root=mkdtempSync(join(tmpdir(),'hermes-interactive-'));
const pkg=join(root,'package'), installed=join(homedir(),'.pi/agent/npm/node_modules/pi-hermes-memory');
const runtime=join(homedir(),'.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent');
const name='ag-pi-memory-'+process.pid;
const run=(cmd,args)=>execFileSync(cmd,cmd==='tmux'?['-L',name,...args]:args,{encoding:'utf8',timeout:15000,maxBuffer:1_000_000});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const med=a=>a.toSorted((x,y)=>x-y)[Math.floor(a.length/2)];
let made=false;
try {
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
  const cmd=['env','-i',`HOME=${home}`,`PATH=${process.env.PATH}`,`TMPDIR=${root}`,`PI_CODING_AGENT_DIR=${agent}`,'PI_OFFLINE=1','PI_SKIP_VERSION_CHECK=1',process.execPath,join(runtime,'dist/cli.js'),'--offline','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-mcp','--no-approve','--provider','fixture','--model','fixture','--thinking','off','-e',fixture].map(quote).join(' ');
  // Do not expose captured pipes to the persistent tmux server.
  execFileSync('tmux',['-L',name,'new-session','-d','-s',name,'-x','110','-y','35','-c',root,cmd],{stdio:'ignore',timeout:15000});made=true;
  // Reaper registration through its public injectable backend, on this private socket.
  const reaper=await import(pathToFileURL(join(repo,'macos/.local/bin/reap-strays.mjs')).href);
  const ps=reaper.createPs();
  const tmux=reaper.createTmux(ps,undefined,(bin,args,env)=>spawnSync(bin,['-L',name,...args.slice(2)],{env,encoding:'utf8',timeout:5000}));
  reaper.registerTmux({name,pid:process.pid,deadline:Math.floor(Date.now()/1000)+90},{ps,tmux,config:{...reaper.configuration(),directory:join(root,'reaper-state')},write:()=>{}});
  const records=()=>existsSync(events)?readFileSync(events,'utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];
  const wait=async(fn)=>{const until=Date.now()+20000;while(Date.now()<until){if(fn())return;await sleep(50)}throw Error('TUI readiness timeout')};
  await wait(()=>records().some(x=>x.type==='ready'));
  run('tmux',['send-keys','-t',name,'memory test','Enter']);await wait(()=>records().some(x=>x.type==='settled'));
  await wait(()=>run('tmux',['capture-pane','-t',name,'-p']).includes('MEMORY_TUI_DONE'));
  run('tmux',['send-keys','-t',name,'/memory-fixture','Enter']);await wait(()=>records().some(x=>x.type==='lookup'));
  await wait(()=>run('tmux',['capture-pane','-t',name,'-p']).includes('MEMORY_LOOKUP_OK'));
  const pid=records().find(x=>x.type==='ready').pid;
  const idleStart=run('ps',['-p',String(pid),'-o','time=']);await sleep(2000);const idleEnd=run('ps',['-p',String(pid),'-o','time=']);
  run('tmux',['send-keys','-t',name,'C-d']);await wait(()=>records().some(x=>x.type==='shutdown'));
  console.log(JSON.stringify({status:'PASS',mode:'real TUI',prompt:'MEMORY_TUI_DONE',memoryTool:'MEMORY_LOOKUP_OK',idleCpu:{before:idleStart.trim(),after:idleEnd.trim(),intervalSeconds:2},note:'CPU resolution only; isolated candidate, no whole-stack comparison'}));
} catch(error) {
  if(made){try{console.error(run('tmux',['capture-pane','-t',name,'-p']).slice(-5000))}catch{}}
  throw error;
} finally {
  if(made){try{run('tmux',['kill-session','-t',name])}catch{}}
  try {run('tmux',['has-session','-t',name]);throw Error('Owned tmux session remains')}catch(e){if(!String(e.message).includes('Command failed'))throw e;}
  try {run('tmux',['kill-server'])}catch{}
  rmSync(root,{recursive:true,force:true});assert(!existsSync(root));
}
