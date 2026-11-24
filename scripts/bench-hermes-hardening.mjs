#!/usr/bin/env node
/** Active hardened v1 versus candidate v2 on the current Pi, private stores, local stream only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { activeHermes, copyHermesCandidate } from './test-hermes-fixture.mjs';
import { resolveManagedRuntime } from './activate-hermes-rolling.mjs';
import { preparePatch, legacyRevision, revision } from './patch-hermes-memory.mjs';
const args=process.argv.slice(2);
const option=name=>{const i=args.indexOf(name);if(i<0)return undefined;assert(args[i+1]&&!args[i+1].startsWith('--'),name+' needs a value');return args[i+1];};
for(const arg of args.filter(x=>x.startsWith('--')))assert(['--output','--pairs','--candidate-first','--validate-only','--runtime'].includes(arg),'Unknown argument '+arg);
const output=option('--output');
assert(output || args.includes('--validate-only'),'Use --output PATH to preserve measurement evidence');
const repeats=Number(option('--pairs')??7);assert(Number.isSafeInteger(repeats)&&repeats>=7&&repeats<=30,'Use 7 to 30 pairs');
const runtime=resolve(option('--runtime')??resolveManagedRuntime());
const runtimeVersion=JSON.parse(fs.readFileSync(join(runtime,'package.json'))).version;
assert.equal(runtimeVersion,'1.6.0','This fixture is reviewed for Pi 1.6.0');
const candidateFirst=args.includes('--candidate-first');
const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'hermes-perf-')));
const packages={baseline:join(root,'baseline'),candidate:join(root,'candidate')};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function sourceHash(dir){
  const files={};const walk=(path,prefix)=>{for(const item of fs.readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){if(item.isDirectory())walk(join(path,item.name),prefix+item.name+'/');else{assert(item.isFile(),'Source symlink');files[prefix+item.name]=hash(fs.readFileSync(join(path,item.name)));}}};
  walk(join(dir,'src'),'src/');files['package.json']=hash(fs.readFileSync(join(dir,'package.json')));
  return {sha256:hash(JSON.stringify(files)),files};
}
const median=a=>{const s=a.toSorted((x,y)=>x-y),m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;};
const stats=a=>{const m=median(a);return {median:m,mad:median(a.map(x=>Math.abs(x-m)))};};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const baselineBefore=sourceHash(activeHermes);
let child;
function stopOwned(proc,signal='SIGKILL') { if(proc&&proc.exitCode===null&&proc.signalCode===null)proc.kill(signal); }
const results={baseline:[],candidate:[]};
const settings={packages:[],compaction:{enabled:false},retry:{enabled:false},cacheWarming:'off',enableInstallTelemetry:false,defaultProjectTrust:'never'};
const hermesConfig={reviewEnabled:false,correctionDetection:false,flushOnShutdown:false,flushOnCompact:false,autoConsolidate:false,quickCheckOnOpen:false};
async function host(variant,round){
  const home=join(root,`${variant}-${round}`),agent=join(home,'.pi/agent');fs.mkdirSync(agent,{recursive:true});
  fs.writeFileSync(join(agent,'settings.json'),JSON.stringify(settings));
  fs.writeFileSync(join(agent,'hermes-memory-config.json'),JSON.stringify({...hermesConfig,memoryDir:join(home,'memory'),projectsMemoryDir:join(home,'projects-memory')}));
  const start=performance.now();
  child=spawn(process.execPath,[join(runtime,'dist/cli.js'),'--offline','--mode','rpc','--no-session','--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-mcp','--no-approve','--provider','fixture','--model','fixture','--thinking','off','-e',join(root,variant+'.ts')],{cwd:home,env:{HOME:home,PATH:process.env.PATH,TMPDIR:home,XDG_CACHE_HOME:join(root,'shared-cache'),JITI_CACHE_DIR:join(root,'shared-jiti'),PI_CODING_AGENT_DIR:agent,PI_OFFLINE:'1',PI_SKIP_VERSION_CHECK:'1'},stdio:['pipe','pipe','pipe']});
  const owned=child, completion=once(owned,'close');
  let buffer='',err='',parseError;const events=[];
  owned.stdout.on('data',b=>{buffer+=b;let ix;while((ix=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,ix);buffer=buffer.slice(ix+1);if(line)try{events.push(JSON.parse(line));}catch(e){parseError=e;}}});
  owned.stderr.on('data',b=>err=(err+b).slice(-8000));
  const timer=setTimeout(()=>stopOwned(owned),20000);
  const wait=async f=>{const end=Date.now()+15000;while(Date.now()<end){if(parseError)throw parseError;if(f())return;assert(owned.exitCode===null&&owned.signalCode===null,'RPC exited '+err);await delay(2);}throw Error('RPC deadline '+err);};
  const command=value=>owned.stdin.write(JSON.stringify(value)+'\n');
  try{
    command({id:'ready',type:'get_state'});await wait(()=>events.some(e=>e.id==='ready'));
    const startupMs=performance.now()-start,turnMs=[];
    for(let i=0;i<5;i++){const count=events.filter(e=>e.type==='agent_settled').length,t=performance.now();command({id:'turn'+i,type:'prompt',message:'Reply FIXTURE_OK'});await wait(()=>events.filter(e=>e.type==='agent_settled').length>count);turnMs.push(performance.now()-t);}
    assert(!events.some(e=>e.type==='extension_error'),JSON.stringify(events.filter(e=>e.type==='extension_error')));
    const assistants=events.filter(e=>e.type==='message_end'&&e.message?.role==='assistant');assert.equal(assistants.length,5);assert(assistants.every(e=>e.message.stopReason==='stop'&&JSON.stringify(e.message.content).includes('FIXTURE_OK')));
    const measure=()=>{
      const raw=execFileSync('/bin/ps',['-p',String(owned.pid),'-o','time=,rss='],{encoding:'utf8',timeout:5000}).trim();
      const [time,rss]=raw.split(/\s+/);const values=time.split(':').map(Number);const cpuSeconds=values.reduce((a,b)=>a*60+b,0);
      assert(Number.isFinite(cpuSeconds)&&Number.isFinite(Number(rss)),raw);return {cpuSeconds,rssKiB:Number(rss)};
    };
    const idleBefore=measure(),idleStart=performance.now();await delay(2000);const idleAfter=measure();
    const row={startupMs,turnMs,idleBefore,idleAfter,idleSeconds:(performance.now()-idleStart)/1000,idleCpuSeconds:idleAfter.cpuSeconds-idleBefore.cpuSeconds};
    results[variant].push(row);
    owned.stdin.end();const [code]=await completion;assert.equal(code,0,err);assert.equal(buffer,'','Unparsed RPC tail');
    console.error(`${round===0?'warmup':'measured'} ${round} ${variant} complete`);
  }finally{
    clearTimeout(timer);if(owned.exitCode===null&&owned.signalCode===null){stopOwned(owned);await completion;}
    // Reviews are disabled, so the benchmark host owns no detached workloads.
    assert(owned.exitCode!==null||owned.signalCode!==null,'Benchmark host did not exit');child=undefined;
  }
}
try{
  assert.equal(preparePatch(activeHermes).revision,legacyRevision,'Baseline must be the active hardened v1');
  fs.cpSync(activeHermes,packages.baseline,{recursive:true});copyHermesCandidate(packages.candidate);
  assert.equal(preparePatch(packages.candidate).revision,revision);
  const sources={baseline:sourceHash(packages.baseline),candidate:sourceHash(packages.candidate)};
  assert.equal(sources.baseline.sha256,baselineBefore.sha256);
  const fixtures={};
  for(const variant of ['baseline','candidate']){
    const code=`import hermes from ${JSON.stringify(join(packages[variant],'src/index.ts'))};import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';export default async function(pi){await hermes(pi);pi.registerProvider('fixture',{api:'fixture-api',baseUrl:'http://local.invalid',apiKey:'fixture',models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:128}],streamSimple(model){const s=createAssistantMessageEventStream();queueMicrotask(()=>{s.push({type:'done',reason:'stop',message:{role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),content:[{type:'text',text:'FIXTURE_OK'}],stopReason:'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}});s.end()});return s}})}`;
    fs.writeFileSync(join(root,variant+'.ts'),code);fixtures[variant]=hash(code.replaceAll(root,'<private-root>'));
  }
  if(args.includes('--validate-only'))console.log(JSON.stringify({verified:true,runtime:runtimeVersion,sources,fixtures,willMeasurePairs:repeats,modelCalls:0}));
  else{
    for(let round=0;round<=repeats;round++)for(const variant of Boolean(round%2)!==candidateFirst?['candidate','baseline']:['baseline','candidate'])await host(variant,round);
    const summary={};for(const variant of ['baseline','candidate']){const rows=results[variant].slice(1);summary[variant]={startupMs:stats(rows.map(x=>x.startupMs)),foregroundTurnMs:stats(rows.map(x=>median(x.turnMs))),rssKiB:stats(rows.map(x=>x.idleAfter.rssKiB)),idleCpuSeconds:stats(rows.map(x=>x.idleCpuSeconds))};}
    const paired={startupMs:[],foregroundTurnMs:[],rssKiB:[]};for(let i=1;i<results.baseline.length;i++){const b=results.baseline[i],c=results.candidate[i];paired.startupMs.push(c.startupMs-b.startupMs);paired.foregroundTurnMs.push(median(c.turnMs)-median(b.turnMs));paired.rssKiB.push(c.idleAfter.rssKiB-b.idleAfter.rssKiB);}
    const pairedStats=Object.fromEntries(Object.entries(paired).map(([k,v])=>[k,stats(v)]));
    // Isolated evidence collection, not a provider or hook latency measurement.
    const modules={};for(const variant of ['baseline','candidate'])modules[variant]=await import(pathToFileURL(join(packages[variant],'src/handlers/message-parts.ts')));
    const datasets={ordinary:Array.from({length:1000},(_,i)=>({type:'message',id:'e'+i,message:{role:i%2?'assistant':'user',content:'ordinary evidence '+i}})),escaped:Array.from({length:20},(_,i)=>({type:'message',id:'id'+i+'\u0000'.repeat(10000),timestamp:'\n'.repeat(10000),message:{role:'user',content:'HEAD'+'\u0000'.repeat(20000)+'TAIL'}}))};
    const evidence={};for(const [name,entries] of Object.entries(datasets)){
      const times={baseline:[],candidate:[]},chars={};
      for(let round=0;round<=repeats;round++)for(const variant of Boolean(round%2)!==candidateFirst?['candidate','baseline']:['baseline','candidate']){const start=performance.now();let batch;for(let i=0;i<20;i++)batch=modules[variant].collectReviewBatch(entries);if(round)times[variant].push((performance.now()-start)/20);chars[variant]=batch.parts.join('\n\n').length;}
      evidence[name]={baselineMs:stats(times.baseline),candidateMs:stats(times.candidate),serializedChars:chars};
    }
    const latency=Object.fromEntries(['startupMs','foregroundTurnMs'].map(k=>[k,{percentChange:100*(summary.candidate[k].median/summary.baseline[k].median-1),paired:pairedStats[k],noiseOver5Percent:Math.max(summary.baseline[k].mad,summary.candidate[k].mad)>summary.baseline[k].median*0.05}]));
    const investigation={latency:Object.values(latency).some(x=>x.percentChange>5),timingNoise:Object.values(latency).some(x=>x.noiseOver5Percent),rssOver10MiB:pairedStats.rssKiB.median>10240,idleActivity:results.candidate.slice(1).some(x=>x.idleCpuSeconds>0)};
    const report={runtime:runtimeVersion,runtimeCliSha256:hash(fs.readFileSync(join(runtime,'dist/cli.js'))),node:process.version,baseline:activeHermes,revisions:{baseline:legacyRevision,candidate:revision},sources,fixtures,settings,hermesConfig,repeats,candidateFirst,summary,paired,pairedStats,latency,evidence,investigation,raw:results,note:'Five local foreground turns per host, one discarded warmup pair, rotated measured pairs, two-second idle CPU and RSS. Private stores, no credentials or API calls. Review and search costs excluded. ps CPU resolution is 10ms; zero means below resolution. Evidence timings are side-channel collection only. Investigate flags before rollout; noisy results are inconclusive.'};
    const path=resolve(output);assert(!fs.existsSync(path),'Refuse to overwrite measurement evidence');fs.writeFileSync(path,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
    console.log(JSON.stringify({output:path,outputSha256:hash(fs.readFileSync(path)),sourceSha256:{baseline:sources.baseline.sha256,candidate:sources.candidate.sha256},summary,latency,investigation,evidence},null,2));
  }
}finally{
  stopOwned(child);assert.deepEqual(sourceHash(activeHermes),baselineBefore,'Active source changed');fs.rmSync(root,{recursive:true,force:true});assert(!fs.existsSync(root));
}
