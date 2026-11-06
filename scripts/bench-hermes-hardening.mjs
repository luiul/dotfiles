#!/usr/bin/env node
/** Alternating real RPC hosts. Private HOME, fixed stream fixture, no external traffic. */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { applyPatch } from './patch-hermes-memory.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..'),root=mkdtempSync(join(tmpdir(),'hermes-perf-'));
const installed=join(homedir(),'.pi/agent/npm/node_modules/pi-hermes-memory'),pkg=join(root,'candidate'),baselinePkg=join(root,'baseline');
const runtime=join(homedir(),'.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent');
const results={baseline:[],candidate:[]};let child;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function host(variant,round){
  const home=join(root,`${variant}-${round}`),agent=join(home,'.pi/agent');mkdirSync(agent,{recursive:true});
  writeFileSync(join(agent,'settings.json'),JSON.stringify({packages:[],compaction:{enabled:false},retry:{enabled:false},cacheWarming:'off',enableInstallTelemetry:false,defaultProjectTrust:'never'}));
  writeFileSync(join(agent,'hermes-memory-config.json'),JSON.stringify({memoryDir:join(home,'memory'),projectsMemoryDir:join(home,'projects-memory'),reviewEnabled:false,correctionDetection:false,flushOnShutdown:false,flushOnCompact:false,autoConsolidate:false,quickCheckOnOpen:false}));
  const start=performance.now();child=spawn(process.execPath,[join(runtime,'dist/cli.js'),'--offline','--mode','rpc','--no-session','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-mcp','--no-approve','--provider','fixture','--model','fixture','--thinking','off','-e',join(root,variant+'.ts')],{cwd:home,env:{HOME:home,PATH:process.env.PATH,TMPDIR:home,PI_CODING_AGENT_DIR:agent,PI_OFFLINE:'1',PI_SKIP_VERSION_CHECK:'1'},detached:true,stdio:['pipe','pipe','pipe']});
  let buffer='',err='';const events=[];child.stdout.on('data',b=>{buffer+=b;let ix;while((ix=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,ix);buffer=buffer.slice(ix+1);if(line)events.push(JSON.parse(line));}});child.stderr.on('data',b=>err+=b);
  const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}},12000);
  const wait=async f=>{const end=Date.now()+10000;while(Date.now()<end){if(f())return;await delay(5)}throw Error('RPC deadline '+err.slice(-1000));};
  const command=v=>child.stdin.write(JSON.stringify(v)+'\n');
  try{
    command({id:'ready',type:'get_state'});await wait(()=>events.some(e=>e.id==='ready'));
    const startupMs=performance.now()-start,turnMs=[];
    for(let i=0;i<3;i++){const count=events.filter(e=>e.type==='agent_settled').length;const t=performance.now();command({id:'turn'+i,type:'prompt',message:'Reply FIXTURE_OK'});await wait(()=>events.filter(e=>e.type==='agent_settled').length>count);turnMs.push(performance.now()-t);}
    assert(!events.some(e=>e.type==='extension_error'),JSON.stringify(events.filter(e=>e.type==='extension_error')));
    const assistants=events.filter(e=>e.type==='message_end'&&e.message?.role==='assistant');assert.equal(assistants.length,3);assert(assistants.every(e=>e.message.stopReason==='stop'));
    const measure=()=>execFileSync('ps',['-p',String(child.pid),'-o','time=,rss='],{encoding:'utf8',timeout:3000}).trim();
    const before=measure();await delay(1000);const after=measure();
    results[variant].push({startupMs,turnMs, idleBefore:before,idleAfter:after});
    child.stdin.end();await once(child,'close');
  }finally{
    clearTimeout(timer);
    const owner=child;
    if(owner.exitCode===null&&owner.signalCode===null){try{process.kill(-owner.pid,'SIGKILL')}catch{}await once(owner,'close');}
    try{process.kill(-owner.pid,'SIGKILL')}catch{}
  }
}
try{
  cpSync(installed,pkg,{recursive:true,filter:p=>!p.slice(installed.length).includes('/node_modules')});cpSync(join(installed,'node_modules'),join(pkg,'node_modules'),{recursive:true});const req=createRequire(join(installed,'package.json'));for(const dep of ['strip-ansi','ansi-regex'])cpSync(dirname(req.resolve(dep)),join(pkg,'node_modules',dep),{recursive:true});  cpSync(pkg,baselinePkg,{recursive:true});applyPatch(pkg,true);
  for(const variant of ['baseline','candidate'])writeFileSync(join(root,variant+'.ts'),`import hermes from ${JSON.stringify(join(variant==='baseline'?baselinePkg:pkg,'src/index.ts'))};import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';export default async function(pi){await hermes(pi);pi.registerProvider('fixture',{api:'fixture-api',baseUrl:'http://local.invalid',apiKey:'fixture',models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:128}],streamSimple(model){const s=createAssistantMessageEventStream();queueMicrotask(()=>{s.push({type:'done',reason:'stop',message:{role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),content:[{type:'text',text:'FIXTURE_OK'}],stopReason:'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}});s.end()});return s}})}`);
  // First pair warms immutable module caches. Seven alternating measured pairs follow.
  const candidateFirst = process.argv.includes('--candidate-first');
  for(let round=0;round<8;round++)for(const variant of Boolean(round%2) !== candidateFirst ? ['candidate','baseline'] : ['baseline','candidate'])await host(variant,round);
  const median=a=>a.toSorted((x,y)=>x-y)[Math.floor(a.length/2)], stats=a=>{const m=median(a);return {median:m,mad:median(a.map(x=>Math.abs(x-m)))}};
  const summary={};for(const variant of ['baseline','candidate']){const rows=results[variant].slice(1);summary[variant]={startupMs:stats(rows.map(x=>x.startupMs)),mainTurnMs:stats(rows.flatMap(x=>x.turnMs)),rssKiB:stats(rows.map(x=>Number(x.idleAfter.split(/\s+/).at(-1)))),idleSamples:rows.map(x=>({before:x.idleBefore,after:x.idleAfter}))};}
  console.log(JSON.stringify({repeats:7,runtime:'1.5.0',candidateFirst,summary,pairedStartupMs:results.baseline.slice(1).map((row,i)=>results.candidate[i+1].startupMs-row.startupMs),note:'Fixed local responses, private Hermes stores, review disabled and searches not exercised; no full-stack or remote model latency claim'},null,2));
}finally{if(child){try{process.kill(-child.pid,'SIGKILL')}catch{}}rmSync(root,{recursive:true,force:true});assert(!existsSync(root));}
process.exit(0);
