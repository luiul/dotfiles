#!/usr/bin/env node
/** Sequential normal-child latency: active v1 watchdog versus candidate v2. No models. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
const args=process.argv.slice(2);
const option=name=>{const i=args.indexOf(name);if(i<0)return undefined;assert(args[i+1]&&!args[i+1].startsWith('--'),name+' needs a value');return args[i+1];};
for(const arg of args.filter(x=>x.startsWith('--')))assert(['--output','--pairs','--candidate-first','--validate-only'].includes(arg),'Unknown argument '+arg);
const output=option('--output'), pairs=Number(option('--pairs')??7),candidateFirst=args.includes('--candidate-first');
assert(Number.isSafeInteger(pairs)&&pairs>=7&&pairs<=30,'Use 7 to 30 pairs');
assert(output||args.includes('--validate-only'),'Use --output PATH for retained evidence');
const repo=resolve(import.meta.dirname,'..');
const sources={baseline:join(homedir(),'.pi/agent/packages/pi-hermes-memory/0.10.0-evidence-v1/src/handlers/child-process-watchdog.mjs'),candidate:join(repo,'pi/.pi/agent/patches/hermes-memory/src/handlers/child-process-watchdog.mjs')};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const before=Object.fromEntries(Object.entries(sources).map(([key,path])=>[key,fs.readFileSync(path)]));
const sourceSha256=Object.fromEntries(Object.entries(before).map(([key,bytes])=>[key,hash(bytes)]));
const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'hermes-child-bench-')));
const fixture=join(root,'workload.mjs');
const fixtureCode=`import fs from 'node:fs';const [dir,kind]=process.argv.slice(2);fs.writeFileSync(dir+'/pid',String(process.pid));const bound=setTimeout(()=>process.exit(99),1500);const large=kind==='buffered';let pending=2;const done=()=>{if(--pending===0){clearTimeout(bound);fs.writeFileSync(dir+'/done',String(Date.now()));process.exit(kind==='nonzero'?7:0);}};process.stdout.write(large?'O'.repeat(2*1024*1024)+'OUT_TAIL':'OK',done);process.stderr.write(large?'E'.repeat(1024*1024)+'ERR_TAIL':'ERR',done);`;
const median=a=>{const s=a.toSorted((a,b)=>a-b),i=Math.floor(s.length/2);return s.length%2?s[i]:(s[i-1]+s[i])/2;};
const stats=a=>{const m=median(a);return {median:m,mad:median(a.map(x=>Math.abs(x-m)))};};
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let owned, cancelled=false;
const abort=()=>{cancelled=true;if(owned&&owned.exitCode===null&&owned.signalCode===null)owned.kill('SIGKILL');};
process.once('SIGINT',abort);process.once('SIGTERM',abort);
const suiteTimer=setTimeout(abort,300000);
async function sample(variant,kind,round){
  assert(!cancelled,'Benchmark cancelled or expired');
  const dir=join(root,`${variant}-${kind}-${round}`);fs.mkdirSync(dir,{mode:0o700});
  const start=performance.now();
  const child=spawn(process.execPath,[join(root,variant+'.mjs'),'5000','-',...(variant==='candidate'?['-']:[]),process.execPath,fixture,dir,kind],{cwd:dir,env:{HOME:dir,PATH:'/usr/bin:/bin',TMPDIR:dir},stdio:['ignore','pipe','pipe']});
  owned=child;const closed=once(child,'close');let stdout='',stderr='';
  child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const timer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},8000);
  try{
    const [code]=await closed;const totalMs=performance.now()-start;
    assert.equal(code,kind==='nonzero'?7:0,stderr.slice(-1000));
    assert.equal(stdout,kind==='buffered'?'O'.repeat(2*1024*1024)+'OUT_TAIL':'OK');
    assert.equal(stderr,kind==='buffered'?'E'.repeat(1024*1024)+'ERR_TAIL':'ERR');
    assert(fs.existsSync(join(dir,'done')),'Missing workload completion');
    const cleanupMs=Date.now()-Number(fs.readFileSync(join(dir,'done')));
    return {totalMs,cleanupMs,stdoutChars:stdout.length,stderrChars:stderr.length};
  }finally{
    clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}
    // Both workloads are finite and cannot spawn descendants. Require PID proof,
    // then verify exit. Never signal remembered PID or a released process group.
    assert(fs.existsSync(join(dir,'pid')),'Missing workload PID evidence');
    const pid=Number(fs.readFileSync(join(dir,'pid')));assert(pid>1);const end=Date.now()+2500;while(alive(pid)&&Date.now()<end)await sleep(20);assert(!alive(pid),'Workload survived bounded cleanup');
    owned=undefined;
  }
}
try{
  fs.writeFileSync(fixture,fixtureCode,{mode:0o600});
  for(const variant of ['baseline','candidate'])fs.writeFileSync(join(root,variant+'.mjs'),before[variant],{mode:0o600});
  if(args.includes('--validate-only'))console.log(JSON.stringify({verified:true,sourceSha256,fixtureSha256:hash(fixtureCode),pairs,modelCalls:0}));
  else{
    const raw={};
    for(const kind of ['success','nonzero','buffered']){
      raw[kind]={baseline:[],candidate:[]};
      // One warmup pair per workload, then at least seven rotated measured pairs.
      for(let round=0;round<=pairs;round++)for(const variant of Boolean(round%2)!==candidateFirst?['candidate','baseline']:['baseline','candidate']){
        const row=await sample(variant,kind,round);if(round)raw[kind][variant].push(row);
        console.error(`${round?'measured':'warmup'} ${kind} ${round} ${variant}`);
      }
    }
    const summary={};
    for(const [kind,rows] of Object.entries(raw)){
      const paired=rows.baseline.map((b,i)=>rows.candidate[i].totalMs-b.totalMs);
      summary[kind]={baselineMs:stats(rows.baseline.map(x=>x.totalMs)),candidateMs:stats(rows.candidate.map(x=>x.totalMs)),baselineCleanupMs:stats(rows.baseline.map(x=>x.cleanupMs)),candidateCleanupMs:stats(rows.candidate.map(x=>x.cleanupMs)),pairedDeltaMs:stats(paired),paired};
      const s=summary[kind];s.percentChange=100*(s.candidateMs.median/s.baselineMs.median-1);s.investigateLatency=s.percentChange>5;s.investigateNoise=Math.max(s.baselineMs.mad,s.candidateMs.mad)>s.baselineMs.median*0.05;
    }
    const report={node:process.version,pairs,candidateFirst,sourceSha256,fixtureSha256:hash(fixtureCode),sources,summary,raw,note:'Sequential bounded watchdog and Node workload wall time, no models or credentials. One warmup pair per workload is discarded. At least seven rotated pairs, medians/MAD and paired differences. Root completion-to-close timing excludes startup. Includes success, nonzero and buffered stdout/stderr integrity. No Pi startup or foreground extension claim.'};
    const path=resolve(output);fs.writeFileSync(path,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
    console.log(JSON.stringify({output:path,outputSha256:hash(fs.readFileSync(path)),sourceSha256,summary},null,2));
  }
}finally{
  clearTimeout(suiteTimer);process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);
  for(const [variant,path] of Object.entries(sources))assert.deepEqual(fs.readFileSync(path),before[variant],'Source changed during measurement');
  fs.rmSync(root,{recursive:true,force:true});assert(!fs.existsSync(root));
}
